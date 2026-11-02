// Camera frame sampling on the phone. Only ROI averages are computed and sent.

export class FrameSampler {
  constructor(video, { roi = 0.5, size = 96, grid = 4 } = {}) {
    this.video = video;
    this.roi = roi;
    this.size = size;
    this.grid = grid;
    this.canvas = document.createElement('canvas');
    this.canvas.width = size; this.canvas.height = size;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
  }

  /** Mean RGB of the central ROI, clipped-pixel fraction, and spatial non-uniformity (CV of grid cells). */
  sample() {
    const v = this.video;
    const vw = v.videoWidth, vh = v.videoHeight;
    if (!vw || !vh) return null;
    const side = Math.min(vw, vh) * this.roi;
    const sx = (vw - side) / 2, sy = (vh - side) / 2;
    const n = this.size;
    this.ctx.drawImage(v, sx, sy, side, side, 0, 0, n, n);
    const d = this.ctx.getImageData(0, 0, n, n).data;
    const sum = [0, 0, 0], clip = [0, 0, 0];
    const g = this.grid, cell = n / g;
    const cells = new Float64Array(g * g);
    for (let y = 0; y < n; y++) {
      const cy = Math.min(g - 1, Math.floor(y / cell));
      for (let x = 0; x < n; x++) {
        const i = (y * n + x) * 4;
        const r = d[i], gg = d[i + 1], b = d[i + 2];
        sum[0] += r; sum[1] += gg; sum[2] += b;
        if (r >= 250) clip[0]++;
        if (gg >= 250) clip[1]++;
        if (b >= 250) clip[2]++;
        cells[cy * g + Math.min(g - 1, Math.floor(x / cell))] += r + gg + b;
      }
    }
    const N = n * n;
    let cm = 0; for (const c of cells) cm += c; cm /= cells.length;
    let cv = 0; for (const c of cells) cv += (c - cm) ** 2;
    cv = cm > 0 ? Math.sqrt(cv / cells.length) / cm : 0;
    return { mean: sum.map((s) => s / N), clip: clip.map((c) => c / N), cv };
  }
}

/** Calls cb once per new video frame (requestVideoFrameCallback when available). */
export function onEachFrame(video, cb) {
  let stop = false;
  if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
    const loop = (now, meta) => { if (stop) return; cb(meta?.mediaTime ?? now); video.requestVideoFrameCallback(loop); };
    video.requestVideoFrameCallback(loop);
  } else {
    let last = -1;
    const loop = () => {
      if (stop) return;
      if (video.currentTime !== last) { last = video.currentTime; cb(last); }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }
  return () => { stop = true; };
}

/**
 * Collect a stable reading: wait settleMs, then average `frames` frames; if the first and
 * second half disagree by more than `tol` (auto-exposure still moving), keep sliding until
 * stable or maxFrames reached.
 */
export function collectReading(video, sampler, { settleMs = 250, frames = 8, maxFrames = 30, tol = 0.003, timeoutMs = 6000 } = {}) {
  return new Promise((resolve, reject) => {
    const samples = [];
    let total = 0, unsub = null, done = false;
    const timer = setTimeout(() => finish(true), settleMs + timeoutMs);
    const lum = (s) => s.mean[0] + s.mean[1] + s.mean[2];
    function finish(timedOut) {
      if (done) return; done = true;
      clearTimeout(timer); unsub && unsub();
      if (!samples.length) return reject(new Error('no frames'));
      const w = samples.slice(-frames);
      const mean = [0, 1, 2].map((i) => w.reduce((s, f) => s + f.mean[i], 0) / w.length);
      const sd = [0, 1, 2].map((i) => Math.sqrt(w.reduce((s, f) => s + (f.mean[i] - mean[i]) ** 2, 0) / Math.max(1, w.length - 1)));
      const clip = [0, 1, 2].map((i) => w.reduce((s, f) => s + f.clip[i], 0) / w.length);
      const cv = w.reduce((s, f) => s + f.cv, 0) / w.length;
      resolve({ mean, sd, clip, cv, n: w.length, framesUsed: total, timedOut: !!timedOut });
    }
    setTimeout(() => {
      unsub = onEachFrame(video, () => {
        const s = sampler.sample();
        if (!s) return;
        samples.push(s); total++;
        if (samples.length >= frames) {
          const w = samples.slice(-frames), h = frames >> 1;
          const a = w.slice(0, h).reduce((t, f) => t + lum(f), 0) / h;
          const b = w.slice(h).reduce((t, f) => t + lum(f), 0) / (frames - h);
          if (Math.abs(a - b) / Math.max(1, (a + b) / 2) <= tol || total >= maxFrames) finish(false);
        }
      });
    }, settleMs);
  });
}
