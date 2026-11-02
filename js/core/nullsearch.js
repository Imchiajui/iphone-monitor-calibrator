// Null (comparison) search: find the solid drive level whose light equals a dither reference.
//
// Why a null method? A phone camera is not a photometer: its output is tone-mapped,
// auto-exposed and white-balanced. But a monotonic, unknown response still answers
// "is A brighter than B?" correctly. By only ever asking that question between two stimuli
// that are made of the *same* primary, we avoid camera non-linearity, auto exposure,
// camera spectral sensitivity (no metamerism: both spectra are the same primary) and
// constant additive light (ambient flare, display black) — they cancel at the match point.
//
// Drift (display warm-up, slow AE/AWB changes) is cancelled to first order by
// bracketing every solid reading between two dither readings (D-S-D sequence).

/** Average two camera readings element-wise. */
export function avgReading(a, b) {
  return {
    mean: a.mean.map((v, i) => (v + b.mean[i]) / 2),
    sd: a.sd.map((v, i) => Math.sqrt((v * v + b.sd[i] * b.sd[i]) / 2)),
    clip: a.clip.map((v, i) => Math.max(v, b.clip[i])),
    n: (a.n || 1) + (b.n || 1),
  };
}

/**
 * Relative difference (solid − reference) / reference using camera channels that are
 * neither clipped nor starved. Equal weighting by the reference signal keeps it monotonic
 * for any positive mixture of channels.
 */
export function relDiff(solid, ref) {
  let num = 0, den = 0, varSum = 0;
  for (let i = 0; i < 3; i++) {
    const ok = ref.mean[i] > 2 && ref.clip[i] < 0.02 && solid.clip[i] < 0.02 && solid.mean[i] < 252;
    if (!ok) continue;
    const w = ref.mean[i];
    num += w * (solid.mean[i] - ref.mean[i]);
    den += w * ref.mean[i];
    const se2 = ((solid.sd[i] ** 2) / (solid.n || 1)) + ((ref.sd[i] ** 2) / (ref.n || 1));
    varSum += w * w * se2;
  }
  if (den === 0) return { value: NaN, se: NaN, usable: false };
  return { value: num / den, se: Math.sqrt(varSum) / den, usable: true };
}

function linFit(points) {
  // weighted least squares y = a + b x
  let sw = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const { x, y, w = 1 } of points) { sw += w; sx += w * x; sy += w * y; sxx += w * x * x; sxy += w * x * y; }
  const det = sw * sxx - sx * sx;
  if (Math.abs(det) < 1e-12) return null;
  const b = (sw * sxy - sx * sy) / det;
  const a = (sy - b * sx) / sw;
  let rss = 0;
  for (const { x, y, w = 1 } of points) rss += w * (y - a - b * x) ** 2;
  const n = points.length;
  // parameter covariance (weights = 1/se²), inflated by reduced chi² when scatter exceeds se
  const chi = n > 2 ? Math.max(1, rss / (n - 2)) : 1;
  const varA = (sxx / det) * chi, varB = (sw / det) * chi, covAB = (-sx / det) * chi;
  return { a, b, rss, n, varA, varB, covAB };
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export class NullMatcher {
  /**
   * @param {object} o
   * @param {(stim)=>Promise<{mean:number[],sd:number[],clip:number[],n:number}>} o.measure
   * @param {(evt)=>void} [o.onEvent]  progress/trace callback
   * @param {number} [o.maxEvals]      max solid evaluations per match
   * @param {number} [o.repeats]       extra D-S-D repeats at the final bracket
   * @param {AbortSignal} [o.signal]
   */
  constructor({ measure, onEvent = () => {}, maxEvals = 12, repeats = 1, signal, settleReadings = 5, settleTol = 0.002 } = {}) {
    this.settleReadings = settleReadings;
    this.settleTol = settleTol;
    this.measure = measure;
    this.onEvent = onEvent;
    this.maxEvals = maxEvals;
    this.repeats = repeats;
    this.signal = signal;
  }

  _check() { if (this.signal?.aborted) throw new DOMException('aborted', 'AbortError'); }

  /**
   * @param {{channel:string, dither:object, guess:number}} q
   * @returns {Promise<{level:number, se:number, slope:number, evals:number, flags:string[], trace:Array}>}
   */
  async match({ channel, dither, guess }) {
    const flags = [];
    const trace = [];
    const byLevel = new Map(); // level -> [{value, se}]
    let refPrev;
    const meas = async (stim) => { this._check(); return this.measure(stim); };
    refPrev = await meas(dither);
    // Pre-roll: let camera auto-exposure / white balance settle on the reference before
    // comparing (AE transients are not linear drift, so D-S-D bracketing can't fully cancel them).
    for (let i = 0; i < this.settleReadings; i++) {
      const again = await meas(dither);
      const ch = relDiff(again, refPrev);
      refPrev = again;
      if (Number.isFinite(ch.value) && Math.abs(ch.value) < this.settleTol) break;
    }
    let nEval = 0;
    const evalLevel = async (level) => {
      const s = await meas({ type: 'solid', channel, level });
      const refNext = await meas(dither);
      const d = relDiff(s, avgReading(refPrev, refNext));
      // Reference change across the D-S-D bracket measures non-linear drift the bracket
      // cannot cancel; fold half of it into the uncertainty so transient points get less weight.
      const drift = relDiff(refNext, refPrev);
      if (Number.isFinite(drift.value)) d.se = Math.hypot(d.se, drift.value / 2);
      refPrev = refNext;
      nEval++;
      if (!d.usable) { flags.push('unusable_signal'); }
      if (!byLevel.has(level)) byLevel.set(level, []);
      byLevel.get(level).push(d);
      trace.push({ level, diff: d.value, se: d.se, ref: refNext.mean.slice(), solid: s.mean.slice() });
      this.onEvent({ type: 'eval', channel, level, diff: d.value, se: d.se });
      return d.value;
    };
    const meanAt = (lvl) => {
      const a = byLevel.get(lvl).filter((d) => Number.isFinite(d.value));
      return a.length ? a.reduce((s, d) => s + d.value, 0) / a.length : NaN;
    };
    const bracket = () => {
      let lo = -Infinity, hi = Infinity;
      for (const lvl of byLevel.keys()) {
        const m = meanAt(lvl);
        if (m < 0 && lvl > lo) lo = lvl;
        if (m > 0 && lvl < hi) hi = lvl;
        if (m === 0) return { lo: lvl, hi: lvl, exact: true };
      }
      return { lo, hi };
    };

    // ---- phase 1: find a bracket (secant steps with overshoot) ----
    let v = clamp(Math.round(guess), 1, 254);
    let d = await evalLevel(v);
    if (!Number.isFinite(d)) return this._fail(flags, trace, nEval, v);
    let vPrev = null, dPrev = null;
    let step = 4;
    while (nEval < this.maxEvals) {
      const br = bracket();
      if (br.exact || (br.lo > -Infinity && br.hi < Infinity && br.lo < br.hi)) break;
      const dir = d > 0 ? -1 : 1;
      let delta = step;
      if (vPrev !== null && dPrev !== null && v !== vPrev) {
        const slope = (d - dPrev) / (v - vPrev);
        if (slope > 0) delta = Math.abs(d / slope) * 1.25 + 0.5;
      }
      delta = clamp(Math.round(delta), 1, 48);
      let next = clamp(v + dir * delta, 0, 255);
      if (next === v) {
        flags.push(dir < 0 ? 'below_range' : 'above_range');
        return { level: v, se: NaN, slope: NaN, evals: nEval, flags, trace };
      }
      vPrev = v; dPrev = d; v = next;
      d = await evalLevel(v);
      step = Math.min(step * 2, 32);
    }

    // ---- phase 2: shrink the bracket to adjacent codes (regula falsi) ----
    let br = bracket();
    let guard = 0;
    while (!br.exact && br.lo > -Infinity && br.hi < Infinity && br.hi - br.lo > 1 && nEval < this.maxEvals && guard++ < 10) {
      const mlo = meanAt(br.lo), mhi = meanAt(br.hi);
      let t = br.lo + (mlo / (mlo - mhi)) * (br.hi - br.lo);
      let next = clamp(Math.round(t), br.lo + 1, br.hi - 1);
      await evalLevel(next);
      br = bracket();
    }
    if (!(br.lo > -Infinity && br.hi < Infinity) || br.lo > br.hi) {
      flags.push('no_bracket');
    }

    // ---- phase 3: repeat the bracketing codes for noise averaging ----
    if (!br.exact && br.lo > -Infinity && br.hi < Infinity) {
      for (let r = 0; r < this.repeats; r++) {
        await evalLevel(br.lo);
        await evalLevel(br.hi);
      }
      br = bracket();
    }

    // ---- final estimate: weighted line fit of diff vs level near the crossing ----
    const centre = br.exact ? br.lo : (br.lo > -Infinity && br.hi < Infinity) ? (br.lo + br.hi) / 2 : v;
    const pts = [];
    for (const [lvl, arr] of byLevel) {
      if (Math.abs(lvl - centre) > 6) continue;
      for (const dd of arr) if (Number.isFinite(dd.value)) pts.push({ x: lvl, y: dd.value, w: 1 / Math.max(dd.se, 1e-4) ** 2 });
    }
    let level = centre, se = NaN, slope = NaN;
    const fit = pts.length >= 2 ? linFit(pts) : null;
    if (fit && fit.b > 0) {
      level = -fit.a / fit.b;
      slope = fit.b;
      // standard error of the root (delta method)
      se = Math.sqrt(Math.max(0, fit.varA + level * level * fit.varB + 2 * level * fit.covAB)) / fit.b;
      if (br.lo > -Infinity && br.hi < Infinity && (level < br.lo - 1 || level > br.hi + 1)) {
        // fit went wild (noise) – fall back to bracket interpolation
        const mlo = meanAt(br.lo), mhi = meanAt(br.hi);
        level = br.lo + (mlo / (mlo - mhi)) * (br.hi - br.lo);
        flags.push('fit_fallback');
      }
    } else if (fit && fit.b <= 0) {
      flags.push('non_monotonic');
    }
    level = clamp(level, 0, 255);
    if (Number.isFinite(se) && se > 0.75) flags.push('noisy');
    this.onEvent({ type: 'match', channel, level, se, flags });
    return { level, se, slope, evals: nEval, flags, trace };
  }

  _fail(flags, trace, nEval, v) {
    flags.push('unusable_signal');
    return { level: v, se: NaN, slope: NaN, evals: nEval, flags, trace };
  }
}
