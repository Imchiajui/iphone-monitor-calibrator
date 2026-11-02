// Small dependency-free SVG line charts with a hover crosshair + tooltip.
// Series carry identity by colour AND dash pattern AND a direct end label (never colour alone).

const NS = 'http://www.w3.org/2000/svg';
const el = (tag, attrs = {}, parent) => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  parent && parent.append(e);
  return e;
};

export const SERIES_STYLE = {
  r: { color: 'var(--ch-r)', dash: '', label: 'R 紅' },
  g: { color: 'var(--ch-g)', dash: '6 3', label: 'G 綠' },
  b: { color: 'var(--ch-b)', dash: '2 3', label: 'B 藍' },
  target: { color: 'var(--ink-muted)', dash: '4 4', label: '目標' },
  before: { color: 'var(--warn)', dash: '', label: '校正前' },
  after: { color: 'var(--good)', dash: '6 3', label: '校正後' },
};

function ticks(lo, hi, n = 5) {
  const step = (hi - lo) / n;
  const p = Math.pow(10, Math.floor(Math.log10(step)));
  const s = [1, 2, 2.5, 5, 10].map((m) => m * p).find((m) => m >= step) || step;
  const out = [];
  for (let v = Math.ceil(lo / s) * s; v <= hi + 1e-9; v += s) out.push(+v.toFixed(10));
  return out;
}

/**
 * @param {HTMLElement} host
 * @param {{series:Array<{id:string,name?:string,points:number[][],markers?:number[][]}>, x:[number,number], y:[number,number], xLabel:string, yLabel:string, fmtX?:Function, fmtY?:Function, title:string}} cfg
 */
export function lineChart(host, cfg) {
  host.innerHTML = '';
  const W = 560, H = 300, m = { l: 52, r: 64, t: 12, b: 40 };
  const fx = (v) => m.l + ((v - cfg.x[0]) / (cfg.x[1] - cfg.x[0])) * (W - m.l - m.r);
  const fy = (v) => H - m.b - ((v - cfg.y[0]) / (cfg.y[1] - cfg.y[0])) * (H - m.t - m.b);
  const fmtX = cfg.fmtX || ((v) => String(Math.round(v)));
  const fmtY = cfg.fmtY || ((v) => v.toFixed(3));
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': cfg.title, class: 'chart' }, host);
  const grid = el('g', { class: 'grid' }, svg);
  for (const t of ticks(cfg.y[0], cfg.y[1])) {
    el('line', { x1: m.l, x2: W - m.r, y1: fy(t), y2: fy(t) }, grid);
    el('text', { x: m.l - 6, y: fy(t) + 4, 'text-anchor': 'end', class: 'tick' }, grid).textContent = fmtY(t);
  }
  for (const t of ticks(cfg.x[0], cfg.x[1])) {
    el('text', { x: fx(t), y: H - m.b + 16, 'text-anchor': 'middle', class: 'tick' }, grid).textContent = fmtX(t);
  }
  el('line', { x1: m.l, x2: W - m.r, y1: H - m.b, y2: H - m.b, class: 'axis' }, svg);
  el('text', { x: (m.l + W - m.r) / 2, y: H - 6, 'text-anchor': 'middle', class: 'axis-label' }, svg).textContent = cfg.xLabel;
  el('text', { x: 12, y: m.t + (H - m.t - m.b) / 2, 'text-anchor': 'middle', class: 'axis-label', transform: `rotate(-90 12 ${m.t + (H - m.t - m.b) / 2})` }, svg).textContent = cfg.yLabel;

  const clampY = (v) => Math.min(cfg.y[1], Math.max(cfg.y[0], v));
  const labels = [];
  for (const s of cfg.series) {
    const st = SERIES_STYLE[s.id] || { color: 'currentColor', dash: '', label: s.id };
    const pts = s.points.filter((p) => Number.isFinite(p[1]));
    if (pts.length) {
      el('path', {
        d: pts.map((p, i) => `${i ? 'L' : 'M'}${fx(p[0]).toFixed(1)},${fy(clampY(p[1])).toFixed(1)}`).join(''),
        fill: 'none', stroke: st.color, 'stroke-width': 2, 'stroke-dasharray': st.dash, 'stroke-linejoin': 'round',
      }, svg);
      const last = pts[pts.length - 1];
      labels.push({ y: fy(clampY(last[1])), text: s.name || st.label, color: st.color });
    }
    for (const p of s.markers || []) {
      el('circle', { cx: fx(p[0]), cy: fy(clampY(p[1])), r: 4, fill: st.color, stroke: 'var(--surface)', 'stroke-width': 2 }, svg);
    }
  }
  // direct end labels, de-collided
  labels.sort((a, b) => a.y - b.y);
  for (let i = 1; i < labels.length; i++) if (labels[i].y - labels[i - 1].y < 13) labels[i].y = labels[i - 1].y + 13;
  for (const l of labels) el('text', { x: W - m.r + 6, y: l.y + 4, class: 'end-label' }, svg).textContent = l.text;

  // hover layer
  const cross = el('line', { y1: m.t, y2: H - m.b, class: 'crosshair', visibility: 'hidden' }, svg);
  const tip = document.createElement('div');
  tip.className = 'tooltip'; tip.hidden = true; host.append(tip);
  const hit = el('rect', { x: m.l, y: m.t, width: W - m.l - m.r, height: H - m.t - m.b, fill: 'transparent' }, svg);
  const interp = (pts, x) => {
    if (!pts.length || x < pts[0][0] || x > pts[pts.length - 1][0]) return NaN;
    let i = 1; while (i < pts.length && pts[i][0] < x) i++;
    if (i >= pts.length) return pts[pts.length - 1][1];
    const a = pts[i - 1], b = pts[i];
    return b[0] === a[0] ? a[1] : a[1] + ((x - a[0]) / (b[0] - a[0])) * (b[1] - a[1]);
  };
  hit.addEventListener('pointermove', (ev) => {
    const r = svg.getBoundingClientRect();
    const px = ((ev.clientX - r.left) / r.width) * W;
    const x = cfg.x[0] + ((px - m.l) / (W - m.l - m.r)) * (cfg.x[1] - cfg.x[0]);
    cross.setAttribute('x1', px); cross.setAttribute('x2', px); cross.setAttribute('visibility', 'visible');
    const rows = cfg.series.map((s) => {
      const st = SERIES_STYLE[s.id] || { label: s.id, color: 'currentColor' };
      const v = interp(s.points, x);
      return Number.isFinite(v) ? `<div><i style="background:${st.color}"></i>${s.name || st.label}: <b>${fmtY(v)}</b></div>` : '';
    }).join('');
    tip.innerHTML = `<div class="tip-h">${cfg.xLabel} ${fmtX(x)}</div>${rows}`;
    tip.hidden = false;
    const hostR = host.getBoundingClientRect();
    tip.style.left = Math.min(ev.clientX - hostR.left + 12, hostR.width - 170) + 'px';
    tip.style.top = (ev.clientY - hostR.top + 12) + 'px';
  });
  hit.addEventListener('pointerleave', () => { tip.hidden = true; cross.setAttribute('visibility', 'hidden'); });
  return svg;
}
