// Full-screen measurement stage on the computer: renders stimuli pixel-exact.
import { renderStimulus, stimulusKey } from '../core/patterns.js';

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

export class Stage {
  constructor(root) {
    this.root = root;
    this.canvas = root.querySelector('canvas');
    this.ctx = this.canvas.getContext('2d', { alpha: false, colorSpace: 'srgb' });
    this.ring = root.querySelector('.ring');
    this.info = root.querySelector('.stage-info');
    this.big = root.querySelector('.stage-big');
    this.cache = new Map();
    this.opts = { patchFrac: 0.4, background: 0 };
  }

  get dpr() { return window.devicePixelRatio || 1; }

  layout(opts = {}) {
    Object.assign(this.opts, opts);
    const dpr = this.dpr;
    const vw = Math.floor(window.innerWidth * dpr), vh = Math.floor(window.innerHeight * dpr);
    // patch side in DEVICE pixels, a multiple of 64 so every pattern tiles an integer number of periods
    let side = Math.floor((Math.min(vw, vh) * this.opts.patchFrac) / 64) * 64;
    side = Math.max(128, side);
    const left = Math.floor((vw - side) / 2), top = Math.floor((vh - side) / 2);
    const c = this.canvas;
    if (c.width !== side) { c.width = side; c.height = side; this.cache.clear(); }
    Object.assign(c.style, { width: side / dpr + 'px', height: side / dpr + 'px', left: left / dpr + 'px', top: top / dpr + 'px' });
    const bg = this.opts.background;
    this.root.style.background = `rgb(${bg},${bg},${bg})`;
    // guide circle circumscribes the patch (never overlaps the measured area)
    const d = (side / dpr) * Math.SQRT2 + 24;
    const cx = (left + side / 2) / dpr, cy = (top + side / 2) / dpr;
    Object.assign(this.ring.style, { width: d + 'px', height: d + 'px', left: (cx - d / 2) + 'px', top: (cy - d / 2) + 'px' });
    this.geometry = { side, left, top, dpr, vw, vh };
    return this.geometry;
  }

  async show(stim) {
    const key = stimulusKey(stim);
    let img = this.cache.get(key);
    if (!img) {
      const side = this.canvas.width;
      img = this.ctx.createImageData(side, side);
      renderStimulus(img.data, side, side, stim);
      this.cache.set(key, img);
      if (this.cache.size > 10) this.cache.delete(this.cache.keys().next().value);
    }
    this.ctx.putImageData(img, 0, 0);
    // two frames: the first commits the paint, the second guarantees it reached the screen
    await nextFrame();
    await nextFrame();
  }

  setInfo(text) { this.info.textContent = text; }
  setBig(html) { this.big.innerHTML = html; this.big.hidden = !html; }

  async enter() {
    this.root.hidden = false;
    document.body.classList.add('staging');
    try { await this.root.requestFullscreen?.({ navigationUI: 'hide' }); } catch {}
    await nextFrame();
    return this.layout();
  }

  async exit() {
    this.root.hidden = true;
    document.body.classList.remove('staging');
    if (document.fullscreenElement) { try { await document.exitFullscreen(); } catch {} }
  }
}
