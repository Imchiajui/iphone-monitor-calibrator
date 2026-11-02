// Virtual display + virtual phone camera, used for the demo mode and automated tests.
// The camera model is deliberately hostile: non-linear tone curve, auto exposure that
// keeps adapting, non-colorimetric spectral response, ambient flare, noise, 8-bit
// quantisation and slow display drift. The null method must still recover the truth.

import { maskFunction, CHANNEL_MASK } from './patterns.js';
import { rgbToXYZMatrix, PRIMARY_PRESETS, matVec } from './colorimetry.js';

// Deterministic PRNG (mulberry32) so tests are reproducible.
export function rng(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gauss(r) {
  const u = Math.max(r(), 1e-12), v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export class VirtualDisplay {
  /**
   * GOG model per channel (Berns 1996):  rel(x) = ((gain·x + offset)^γ − offset^γ) / ((gain+offset)^γ − offset^γ)
   */
  constructor({
    gamma = { r: 2.35, g: 2.2, b: 2.05 },
    offset = { r: 0.02, g: 0.0, b: -0.03 },
    peak = { r: 1, g: 1, b: 1 },          // relative channel scale (native white imbalance)
    blackRel = 0.0015,                    // black luminance / white luminance
    primaries = 'srgb',
    crosstalk = 0,                        // fractional loss per horizontal ON/OFF transition
    driftPerMin = 0,                      // relative luminance drift per minute
  } = {}) {
    Object.assign(this, { gamma, offset, peak, blackRel, crosstalk, driftPerMin });
    this.M = rgbToXYZMatrix(PRIMARY_PRESETS[primaries] || primaries);
  }

  rel(c, level) {
    const x = Math.min(1, Math.max(0, level / 255));
    const g = this.gamma[c], o = this.offset[c];
    const a = 1 - o;
    const f = (t) => Math.pow(Math.max(a * t + o, 0), g);
    return (f(x) - f(0)) / (f(1) - f(0));
  }

  // Linear RGB "drive" (black-subtracted) of a stimulus averaged over area.
  stimulusLinear(s, size = 64) {
    const ch = CHANNEL_MASK[s.channel];
    let avg;
    if (s.type === 'solid') {
      const lvl = Math.min(255, Math.max(0, s.level));
      const lo = Math.floor(lvl), f = lvl - lo;
      const sub = Math.round(f * 16) / 16;
      avg = (c) => (1 - sub) * this.rel(c, lo) + sub * this.rel(c, Math.min(255, lo + 1));
    } else {
      const on = maskFunction(s);
      let count = 0, trans = 0;
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        const v = on(x, y);
        if (v) count++;
        if (v !== on(x + 1, y)) trans++;
      }
      const frac = count / (size * size);
      const tdens = trans / (size * size);
      avg = (c) => {
        const hi = this.rel(c, s.hi ?? 255), lo = this.rel(c, s.lo ?? 0);
        return lo + frac * (hi - lo) - this.crosstalk * tdens * (hi - lo);
      };
    }
    return [0, 1, 2].map((i) => (ch[i] ? avg('rgb'[i]) * this.peak['rgb'[i]] : 0));
  }

  stimulusXYZ(s, tMin = 0) {
    const lin = this.stimulusLinear(s);
    const drift = 1 + this.driftPerMin * tMin;
    const xyz = matVec(this.M, lin).map((v) => v * drift);
    const k = matVec(this.M, [1, 1, 1]);
    return xyz.map((v, i) => v + this.blackRel * k[i]);
  }
}

export class VirtualCamera {
  constructor({
    seed = 7,
    noise = 1.2,              // per-pixel code-value noise (σ)
    pixels = 4096,            // ROI pixel count averaged
    framesPerReading = 8,
    ambient = 0.004,          // additive flare (relative to white Y)
    aeTarget = 0.42,          // AE drives the mean encoded level to this
    aeSpeed = 0.35,           // fraction of the AE error corrected per reading
    // camera "RGB sensitivities" as a 3×3 from XYZ – deliberately not colorimetric
    camMatrix = [[1.9, -0.6, -0.25], [-0.7, 1.7, 0.05], [0.05, -0.25, 1.15]],
  } = {}) {
    Object.assign(this, { noise, pixels, framesPerReading, ambient, aeTarget, aeSpeed, camMatrix });
    this.r = rng(seed);
    this.exposure = 1.0;
  }

  tone(v) {
    // S-shaped, non-linear "ISP" tone curve with a shoulder (filmic); unknown to the algorithm
    const t = Math.max(0, v);
    const s = Math.pow(t, 1 / 2.4);
    return 255 * (s * 1.15) / (1 + 0.15 * s * s);
  }

  capture(xyz) {
    const raw = matVec(this.camMatrix, xyz.map((v) => v + this.ambient * (v >= 0 ? 1 : 1)));
    const mean = [], sd = [], clip = [];
    const enc = raw.map((r) => this.tone(Math.max(0, r) * this.exposure));
    for (let i = 0; i < 3; i++) {
      const noisy = enc[i] + gauss(this.r) * this.noise / Math.sqrt(this.pixels * this.framesPerReading);
      const q = Math.min(255, Math.max(0, noisy));
      mean.push(q);
      sd.push(this.noise);
      clip.push(enc[i] >= 254.5 ? 1 : 0);
    }
    // auto-exposure keeps adapting towards a mid-grey average (as iPhone AE does)
    const luma = (enc[0] + enc[1] + enc[2]) / 3 / 255;
    if (luma > 0.001) {
      const err = this.aeTarget / luma;
      this.exposure *= Math.pow(err, this.aeSpeed * 2.4);
      this.exposure = Math.min(Math.max(this.exposure, 1e-3), 1e4);
    }
    return { mean, sd, clip, n: this.framesPerReading };
  }
}

/** A measure(stim) function backed by the simulation. */
export function simulatedSensor({ display = new VirtualDisplay(), camera = new VirtualCamera(), msPerReading = 600, delay = 0 } = {}) {
  let tMs = 0;
  const fn = async (stim) => {
    tMs += msPerReading;
    if (delay) await new Promise((r) => setTimeout(r, delay));
    return camera.capture(display.stimulusXYZ(stim, tMs / 60000));
  };
  fn.display = display;
  fn.camera = camera;
  fn.elapsedMs = () => tMs;
  return fn;
}
