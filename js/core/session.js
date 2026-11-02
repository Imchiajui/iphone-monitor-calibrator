// Measurement plan & runner (pure; transport-agnostic).

import { NullMatcher } from './nullsearch.js';

export const MODES = {
  quick: {
    name: '快速（約 2 分鐘）',
    fractions: [[1, 2], [1, 4], [3, 4], [1, 8], [1, 16, 'bayer']],
    consistency: false,
    repeats: 1,
  },
  standard: {
    name: '標準（約 5–7 分鐘，推薦）',
    fractions: [[1, 2], [1, 4], [3, 4], [1, 8], [3, 8], [5, 8], [7, 8], [1, 16, 'bayer'], [2, 64, 'bayer']],
    consistency: true,
    repeats: 1,
  },
  precise: {
    name: '精密（約 10–14 分鐘）',
    fractions: [[1, 2], [1, 4], [3, 4], [1, 8], [3, 8], [5, 8], [7, 8], [1, 16, 'bayer'], [2, 64, 'bayer'], [1, 64, 'bayer'], [3, 16, 'bayer'], [13, 16, 'bayer']],
    consistency: true,
    repeats: 2,
  },
};

export const VERIFY_FRACTIONS = [[3, 16], [7, 16], [11, 16], [14, 16]];

function guessLevel(points, rel) {
  // power-law guess from points measured so far
  const g = points.filter((p) => p.rel > 0 && p.rel < 1 && p.level > 0 && p.level < 255)
    .map((p) => Math.log(p.rel) / Math.log(p.level / 255))
    .filter((v) => Number.isFinite(v) && v > 0.8 && v < 4);
  const gamma = g.length ? g.reduce((a, b) => a + b, 0) / g.length : 2.2;
  return 255 * Math.pow(rel, 1 / gamma);
}

function ditherFor(channel, k, n, geometry, block) {
  return { type: 'dither', channel, k, n, geometry, block, hi: 255, lo: 0 };
}

/**
 * Run the per-channel null-method characterisation.
 * @returns {Promise<object>} raw result (serialisable)
 */
export async function runCharacterisation({
  measure, mode = 'standard', block = 1, channels = ['r', 'g', 'b'],
  onProgress = () => {}, onEvent = () => {}, signal,
}) {
  const cfg = MODES[mode];
  if (!cfg) throw new Error('unknown mode');
  const matcher = new NullMatcher({ measure, onEvent, repeats: cfg.repeats, signal });
  const tasks = [];
  for (const c of channels) {
    for (const [k, n, geo] of cfg.fractions) tasks.push({ kind: 'curve', channel: c, k, n, geometry: geo || 'rows', block: geo === 'bayer' ? 1 : block });
    if (cfg.consistency) {
      tasks.push({ kind: 'consistency', channel: c, k: 1, n: 2, geometry: 'cols', block });
      tasks.push({ kind: 'consistency', channel: c, k: 1, n: 2, geometry: 'rows', block: block * 2 });
      tasks.push({ kind: 'consistency', channel: c, k: 1, n: 2, geometry: 'checker', block });
    }
  }
  tasks.push({ kind: 'drift', channel: channels[0], k: 1, n: 2, geometry: 'rows', block });

  const started = Date.now();
  const res = { version: 1, mode, block, channels, startedAt: new Date(started).toISOString(), points: {}, consistency: {}, drift: null, log: [] };
  for (const c of channels) { res.points[c] = []; res.consistency[c] = []; }

  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i];
    onProgress({ index: i, total: tasks.length, task: t });
    const rel = t.k / t.n;
    const guess = guessLevel(res.points[t.channel], rel);
    const m = await matcher.match({ channel: t.channel, dither: ditherFor(t.channel, t.k, t.n, t.geometry, t.block), guess });
    const rec = { k: t.k, n: t.n, rel, geometry: t.geometry, block: t.block, level: m.level, se: m.se, slope: m.slope, evals: m.evals, flags: m.flags };
    if (t.kind === 'curve') res.points[t.channel].push(rec);
    else if (t.kind === 'consistency') res.consistency[t.channel].push(rec);
    else if (t.kind === 'drift') {
      const first = res.points[t.channel].find((p) => p.k === 1 && p.n === 2);
      res.drift = { channel: t.channel, first: first?.level, last: m.level, se: m.se, minutes: (Date.now() - started) / 60000 };
    }
    res.log.push({ ...t, level: m.level, se: m.se, flags: m.flags, evals: m.evals });
  }
  onProgress({ index: tasks.length, total: tasks.length, done: true });
  res.durationMs = Date.now() - started;
  return res;
}

/**
 * Independent verification: measure fractions NOT used in the fit, with a different pattern
 * geometry (Bayer), and compare against the fitted model (cross-validation).
 */
export async function runVerification({ measure, models, channels = ['r', 'g', 'b'], fractions = VERIFY_FRACTIONS, onProgress = () => {}, onEvent = () => {}, signal }) {
  const matcher = new NullMatcher({ measure, onEvent, repeats: 1, signal });
  const out = {};
  const total = channels.length * fractions.length;
  let idx = 0;
  for (const c of channels) {
    out[c] = [];
    for (const [k, n] of fractions) {
      onProgress({ index: idx++, total, task: { channel: c, k, n } });
      const rel = k / n;
      const guess = 255 * models[c].inverse(rel);
      const m = await matcher.match({ channel: c, dither: ditherFor(c, k, n, 'bayer', 1), guess });
      const predicted = models[c].forward(m.level / 255);
      out[c].push({ k, n, rel, level: m.level, se: m.se, predictedRel: predicted, errorPct: ((rel - predicted) / predicted) * 100, flags: m.flags });
    }
  }
  onProgress({ index: total, total, done: true });
  return out;
}
