// Tone-response curve utilities (pure).
//
// Conventions used throughout the project:
//   level  : display drive value, 0..255 (may be fractional when interpolated)
//   x      : normalised drive, level / 255
//   rel    : black-subtracted relative luminance of one channel,
//            rel = (Y(level) - Y(0)) / (Y(255) - Y(0))   ∈ [0, 1]
// The camera null-method measures exactly `rel` (black and ambient flare cancel),
// see docs/METHOD.md §3.

// ---------- target EOTFs (all return black-subtracted relative luminance) ----------
export const TARGETS = {
  gamma22: { name: 'Gamma 2.2（Windows/網頁/一般用途，推薦）', fn: (x) => Math.pow(x, 2.2) },
  srgb: {
    name: 'sRGB 分段曲線 (IEC 61966-2-1)',
    fn: (x) => (x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4)),
  },
  gamma24: { name: 'Gamma 2.4（暗室影片）', fn: (x) => Math.pow(x, 2.4) },
  gamma18: { name: 'Gamma 1.8（舊式 Mac 印前）', fn: (x) => Math.pow(x, 1.8) },
};

// ITU-R BT.1886 EOTF, normalised to black-subtracted relative luminance.
export function bt1886(contrast) {
  const Lw = 1, Lb = 1 / Math.max(contrast, 2);
  const g = 2.4;
  const a = Math.pow(Math.pow(Lw, 1 / g) - Math.pow(Lb, 1 / g), g);
  const b = Math.pow(Lb, 1 / g) / (Math.pow(Lw, 1 / g) - Math.pow(Lb, 1 / g));
  return (x) => {
    const L = a * Math.pow(Math.max(x + b, 0), g);
    return (L - Lb) / (Lw - Lb);
  };
}

export function targetFunction(id, opts = {}) {
  if (id === 'bt1886') return bt1886(opts.contrast || 1000);
  if (TARGETS[id]) return TARGETS[id].fn;
  throw new Error('unknown target ' + id);
}

// ---------- isotonic regression (pool-adjacent-violators) ----------
// Returns a non-decreasing sequence closest (weighted L2) to `ys`.
export function isotonic(ys, ws) {
  const w = ws ? ws.slice() : ys.map(() => 1);
  const blocks = [];
  for (let i = 0; i < ys.length; i++) {
    blocks.push({ v: ys[i], w: w[i], n: 1 });
    while (blocks.length > 1 && blocks[blocks.length - 2].v > blocks[blocks.length - 1].v) {
      const b = blocks.pop(), a = blocks.pop();
      const wt = a.w + b.w;
      blocks.push({ v: (a.v * a.w + b.v * b.w) / wt, w: wt, n: a.n + b.n });
    }
  }
  const out = [];
  for (const b of blocks) for (let k = 0; k < b.n; k++) out.push(b.v);
  return out;
}

// ---------- monotone cubic Hermite interpolation (Fritsch & Carlson, 1980) ----------
export function monotoneSpline(xs, ys) {
  const n = xs.length;
  if (n < 2) throw new Error('need ≥ 2 points');
  for (let i = 1; i < n; i++) if (!(xs[i] > xs[i - 1])) throw new Error('xs must be strictly increasing');
  const d = new Array(n - 1), m = new Array(n);
  for (let i = 0; i < n - 1; i++) d[i] = (ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]);
  m[0] = d[0]; m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / d[i], b = m[i + 1] / d[i];
    const s = a * a + b * b;
    if (s > 9) { const t = 3 / Math.sqrt(s); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
  }
  return (x) => {
    if (x <= xs[0]) return ys[0] + m[0] * (x - xs[0]);
    if (x >= xs[n - 1]) return ys[n - 1] + m[n - 1] * (x - xs[n - 1]);
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (xs[mid] <= x) lo = mid; else hi = mid; }
    const h = xs[hi] - xs[lo], t = (x - xs[lo]) / h;
    const t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[lo] + (t3 - 2 * t2 + t) * h * m[lo]
      + (-2 * t3 + 3 * t2) * ys[hi] + (t3 - t2) * h * m[hi];
  };
}

// Interpolation is done in log–log space (log rel vs log x). A display tone curve is close
// to a power law there, so a monotone spline through sparse points is accurate, and the
// spline's linear end-extrapolation becomes a power-law extrapolation into the shadows
// (below the darkest measured point) — the physically expected behaviour (Berns 1996 GOG).

/**
 * Build a channel response model from null-method match points.
 * @param {Array<{rel:number, level:number, weight?:number}>} points  measured matches
 * @returns {{forward:(x:number)=>number, inverse:(rel:number)=>number, knots:Array}}
 *   forward: x(0..1) -> rel ; inverse: rel -> x(0..1)
 */
export function buildChannelModel(points) {
  const pts = points
    .filter((p) => p.rel > 0 && p.rel < 1 && Number.isFinite(p.level) && p.level > 0 && p.level < 255)
    .sort((a, b) => a.rel - b.rel);
  if (!pts.length) throw new Error('no usable points');
  // enforce monotonic levels (noise could produce tiny inversions)
  const levels = isotonic(pts.map((p) => p.level), pts.map((p) => p.weight || 1));
  const lx = [], ly = [];
  for (let i = 0; i < pts.length; i++) {
    const x = Math.log(Math.min(levels[i] / 255, 1 - 1e-6));
    if (lx.length && x <= lx[lx.length - 1] + 1e-6) continue; // pooled duplicates
    lx.push(x); ly.push(Math.log(pts[i].rel));
  }
  lx.push(0); ly.push(0); // (x=1, rel=1)
  if (lx.length === 2) { // single point: pure power law
    const g = ly[0] / lx[0];
    return { forward: (x) => (x <= 0 ? 0 : Math.min(1, x ** g)), inverse: (r) => (r <= 0 ? 0 : Math.min(1, r ** (1 / g))), knots: [] };
  }
  const f = monotoneSpline(lx, ly); // log x -> log rel
  const g = monotoneSpline(ly, lx); // log rel -> log x
  return {
    forward: (x) => (x <= 0 ? 0 : x >= 1 ? 1 : Math.min(1, Math.exp(f(Math.log(x))))),
    inverse: (rel) => (rel <= 0 ? 0 : rel >= 1 ? 1 : Math.min(1, Math.exp(g(Math.log(rel))))),
    knots: lx.map((x, i) => ({ x: Math.exp(x), rel: Math.exp(ly[i]) })),
  };
}

// Effective ("point") gamma at drive x for relative luminance rel.
export function pointGamma(x, rel) {
  if (x <= 0 || x >= 1 || rel <= 0 || rel >= 1) return NaN;
  return Math.log(rel) / Math.log(x);
}

/**
 * Build 1D calibration LUTs (vcgt) that make each channel follow `target`.
 * @param models {r,g,b} channel models from buildChannelModel
 * @param target (x)->rel
 * @param scale  {r,g,b} white-point scaling (1 = native white)
 * @param size   number of entries
 * @returns {r:Float64Array,g:Float64Array,b:Float64Array} values in 0..1
 */
export function buildCalibrationLUT(models, target, scale = { r: 1, g: 1, b: 1 }, size = 256) {
  const out = {};
  for (const c of ['r', 'g', 'b']) {
    const lut = new Float64Array(size);
    for (let i = 0; i < size; i++) {
      const x = i / (size - 1);
      lut[i] = models[c].inverse(target(x) * scale[c]);
    }
    lut[0] = 0;
    // guarantee monotonic non-decreasing output
    for (let i = 1; i < size; i++) if (lut[i] < lut[i - 1]) lut[i] = lut[i - 1];
    out[c] = lut;
  }
  return out;
}

// Sample a function on [0,1] into an array (for ICC curveType tags).
export function sampleCurve(fn, n = 1024) {
  const a = new Float64Array(n);
  for (let i = 0; i < n; i++) a[i] = Math.min(1, Math.max(0, fn(i / (n - 1))));
  return a;
}
