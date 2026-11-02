// Stimulus definitions and pixel-exact rendering (pure; works on any RGBA buffer).
//
// A *dither* stimulus turns a fraction k/n of the device pixels fully ON (level `hi`)
// and leaves the rest at `lo` (normally 0). If pixels are independent (additivity),
// its spatially-averaged luminance is exactly  Y(lo) + k/n·(Y(hi) − Y(lo)).
// The camera never has to be linear: it only has to tell whether a solid patch is
// brighter or darker than this dither (null / comparison method, docs/METHOD.md §3).

// Recursive Bayer (ordered-dither) index matrices: 2×2, 4×4, 8×8.
function bayer(size) {
  if (size === 1) return [[0]];
  const h = bayer(size / 2), n = size / 2;
  const m = Array.from({ length: size }, () => new Array(size));
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const v = 4 * h[y][x];
    m[y][x] = v; m[y][x + n] = v + 2; m[y + n][x] = v + 3; m[y + n][x + n] = v + 1;
  }
  return m;
}
const BAYER = { 4: bayer(2), 16: bayer(4), 64: bayer(8) };

// Bit-reversal ordering spreads the ON rows as evenly as possible inside a period.
function bitReverseRank(n) {
  const bits = Math.round(Math.log2(n));
  if (1 << bits !== n) throw new Error('period must be a power of two');
  const rank = new Array(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b);
    rank[i] = r;
  }
  return rank;
}
const RANK_CACHE = {};
function rankFor(n) { return (RANK_CACHE[n] ||= bitReverseRank(n)); }

export const GEOMETRIES = {
  rows: '水平線 (rows)',
  cols: '垂直線 (cols)',
  checker: '棋盤格 (checker)',
  bayer: 'Bayer 有序點陣',
};

/** Returns a function (x, y) -> boolean (pixel ON). */
export function maskFunction({ k, n, geometry = 'rows', block = 1 }) {
  if (k <= 0) return () => false;
  if (k >= n) return () => true;
  const B = Math.max(1, block | 0);
  switch (geometry) {
    case 'rows': {
      const rank = rankFor(n);
      return (x, y) => rank[Math.floor(y / B) % n] < k;
    }
    case 'cols': {
      const rank = rankFor(n);
      return (x, y) => rank[Math.floor(x / B) % n] < k;
    }
    case 'checker': {
      if (n !== 2) throw new Error('checker supports only n = 2');
      return (x, y) => ((Math.floor(x / B) + Math.floor(y / B)) & 1) === 0;
    }
    case 'bayer': {
      const M = BAYER[n];
      if (!M) throw new Error('bayer supports n = 4, 16 or 64');
      const s = M.length;
      return (x, y) => M[Math.floor(y / B) % s][Math.floor(x / B) % s] < k;
    }
    default:
      throw new Error('unknown geometry ' + geometry);
  }
}

/** Smallest tile (device px) that repeats the pattern exactly. */
export function patternPeriod({ n, geometry = 'rows', block = 1 }) {
  const B = Math.max(1, block | 0);
  if (geometry === 'checker') return 2 * B;
  if (geometry === 'bayer') return Math.sqrt(n) * B;
  return n * B;
}

export const CHANNEL_MASK = { r: [1, 0, 0], g: [0, 1, 0], b: [0, 0, 1], w: [1, 1, 1] };

/**
 * Stimulus shapes:
 *   { type:'solid',  channel:'r'|'g'|'b'|'w', level:Number }   (fractional level → fine ordered dither of the two neighbouring codes)
 *   { type:'dither', channel, k, n, geometry, block, hi:255, lo:0 }
 */
export function stimulusKey(s) {
  if (s.type === 'solid') return `S:${s.channel}:${s.level}`;
  return `D:${s.channel}:${s.k}/${s.n}:${s.geometry}:${s.block}:${s.lo ?? 0}-${s.hi ?? 255}`;
}

/** Render stimulus into RGBA buffer `data` of size w×h (origin must be device-pixel aligned). */
export function renderStimulus(data, w, h, s, ox = 0, oy = 0) {
  const ch = CHANNEL_MASK[s.channel];
  if (!ch) throw new Error('bad channel');
  let on, valOn, valOff;
  if (s.type === 'solid') {
    const lvl = Math.min(255, Math.max(0, s.level));
    const lo = Math.floor(lvl), frac = lvl - lo;
    const sub = Math.round(frac * 16);
    if (sub === 0 || sub === 16) {
      const v = sub === 16 ? lo + 1 : lo;
      on = () => true; valOn = v; valOff = v;
    } else {
      // fine ordered dither between adjacent codes: luminance step between two adjacent codes
      // is tiny (<1.5 %), so the averaging error caused by non-linear blending is negligible.
      on = maskFunction({ k: sub, n: 16, geometry: 'bayer', block: 1 });
      valOn = lo + 1; valOff = lo;
    }
  } else if (s.type === 'dither') {
    on = maskFunction(s);
    valOn = s.hi ?? 255; valOff = s.lo ?? 0;
  } else throw new Error('bad stimulus');
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = on(x + ox, y + oy) ? valOn : valOff;
      const i = (y * w + x) * 4;
      data[i] = ch[0] * v; data[i + 1] = ch[1] * v; data[i + 2] = ch[2] * v; data[i + 3] = 255;
    }
  }
}

/** Exact ON-pixel fraction of a pattern over a w×h area (for tests / diagnostics). */
export function measuredFraction(spec, w, h) {
  const on = maskFunction(spec);
  let c = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (on(x, y)) c++;
  return c / (w * h);
}
