import { createLink, randomRoom } from '../common/transport.js';
import { Stage } from './stage.js';
import { lineChart } from './charts.js';
import { MODES, runCharacterisation, runVerification } from '../core/session.js';
import { analyse, buildProfiles, verificationSummary, LIMITS } from '../core/analysis.js';
import { TARGETS } from '../core/curves.js';
import { PRIMARY_PRESETS, ILLUMINANTS } from '../core/colorimetry.js';
import { VirtualDisplay, VirtualCamera, simulatedSensor } from '../core/simulator.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const qs = new URLSearchParams(location.search);
const transportKind = qs.get('transport') || 'peer';

const store = {
  get(k, d) { try { const v = localStorage.getItem('imcal-' + k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('imcal-' + k, JSON.stringify(v)); } catch {} },
};

const app = {
  link: null, sensorReady: false, sim: null, stage: new Stage($('#stage')),
  raw: store.get('raw', null), verify: store.get('verify', null), analysis: null, abort: null,
  live: null, seq: 0, pending: new Map(), dprAtRun: null, ditherCv: [],
};

// ------------------------------------------------------------------ settings
function fillSelect(sel, entries, value) {
  sel.innerHTML = '';
  for (const [v, label] of entries) { const o = document.createElement('option'); o.value = v; o.textContent = label; sel.append(o); }
  if (value != null) sel.value = value;
}
fillSelect($('#set-mode'), Object.entries(MODES).map(([k, m]) => [k, m.name]), 'standard');
fillSelect($('#set-target'), [...Object.entries(TARGETS).map(([k, t]) => [k, t.name]), ['bt1886', 'ITU-R BT.1886（影片，需輸入對比）']], 'gamma22');
fillSelect($('#set-primaries'), [...Object.entries(PRIMARY_PRESETS).map(([k, p]) => [k, p.name]), ['custom', '自訂（輸入 xy 色度）']], 'srgb');

const settingIds = ['set-mode', 'set-target', 'set-contrast', 'set-primaries', 'set-white', 'set-block', 'set-patch', 'set-bg', 'set-settle', 'set-frames'];
const saved = store.get('settings', {});
for (const id of settingIds) if (saved[id] != null) $('#' + id).value = saved[id];
for (const inp of $$('[data-xy]')) if (saved['xy:' + inp.dataset.xy] != null) inp.value = saved['xy:' + inp.dataset.xy];

function settings() {
  const s = {};
  for (const id of settingIds) s[id] = $('#' + id).value;
  for (const inp of $$('[data-xy]')) s['xy:' + inp.dataset.xy] = inp.value;
  return s;
}
function saveSettings() { store.set('settings', settings()); }
function syncSettingsUI() {
  $('#field-contrast').hidden = $('#set-target').value !== 'bt1886';
  $('#custom-primaries').hidden = $('#set-primaries').value !== 'custom' && $('#set-white').value === 'native';
}
for (const id of settingIds) $('#' + id).addEventListener('change', () => { saveSettings(); syncSettingsUI(); if (app.raw) recompute(); });
for (const inp of $$('[data-xy]')) inp.addEventListener('change', () => { saveSettings(); if (app.raw) recompute(); });
syncSettingsUI();

function primariesFromUI() {
  const id = $('#set-primaries').value;
  const white = $('#set-white').value;
  if (id !== 'custom' && white === 'native') return PRIMARY_PRESETS[id];
  const base = id === 'custom' ? {} : PRIMARY_PRESETS[id];
  const p = { r: { ...base.r }, g: { ...base.g }, b: { ...base.b }, w: { ...base.w } };
  for (const inp of $$('[data-xy]')) {
    const [c, k] = inp.dataset.xy.split('.');
    const v = parseFloat(inp.value);
    // when a preset is chosen only the white field is taken from the custom inputs
    if (Number.isFinite(v) && (id === 'custom' || c === 'w')) p[c][k] = v;
  }
  return p;
}

function analysisOptions() {
  const white = $('#set-white').value;
  return {
    target: $('#set-target').value,
    contrast: parseFloat($('#set-contrast').value) || 1000,
    primaries: primariesFromUI(),
    retargetWhite: white === 'd65' ? ILLUMINANTS.D65 : white === 'd50' ? ILLUMINANTS.D50 : null,
  };
}

// ------------------------------------------------------------------ environment checks
function envChecks() {
  const out = [];
  const dpr = window.devicePixelRatio || 1;
  const integer = Math.abs(dpr - Math.round(dpr)) < 0.01;
  out.push({ ok: integer, text: `裝置像素比 devicePixelRatio = ${dpr.toFixed(3)}` + (integer ? '（整數，格紋可逐像素顯示）' : '（非整數：瀏覽器縮放或系統縮放會重新取樣格紋→請把瀏覽器縮放調回 100% 或在進階設定把像素區塊改為 2）') });
  const hdr = matchMedia('(dynamic-range: high)').matches;
  out.push({ ok: true, info: true, text: hdr ? '此螢幕支援 HDR：量測前請關閉系統 HDR 模式' : '未偵測到 HDR 模式' });
  const p3 = matchMedia('(color-gamut: p3)').matches;
  out.push({ ok: true, info: true, text: p3 ? '偵測到廣色域螢幕（≥P3）：原色請選 Display P3 / Adobe RGB 或自訂' : '色域約為 sRGB' });
  out.push({ ok: !!document.documentElement.requestFullscreen, text: document.documentElement.requestFullscreen ? '支援全螢幕' : '此瀏覽器不支援全螢幕 API（仍可量測，請手動最大化）' });
  out.push({ ok: window.isSecureContext, text: window.isSecureContext ? 'HTTPS 安全環境' : '非 HTTPS：手機端相機將無法使用' });
  $('#env-checks').innerHTML = out.map((c) => `<div class="check ${c.info ? 'info' : c.ok ? 'ok' : 'bad'}"><span>${c.info ? 'ℹ' : c.ok ? '✓' : '⚠'}</span>${c.text}</div>`).join('');
}
envChecks();
matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`).addEventListener?.('change', envChecks);

// ------------------------------------------------------------------ connection
function setLinkStatus(text, kind) { const el = $('#link-status'); el.textContent = text; el.dataset.kind = kind || ''; }

function setupLink() {
  let room = store.get('room', null);
  if (!room || qs.get('newroom')) { room = qs.get('room') || randomRoom(); store.set('room', room); }
  if (qs.get('room')) room = qs.get('room');
  const base = new URL('sensor.html', location.href);
  const hash = new URLSearchParams({ room });
  if (transportKind !== 'peer') hash.set('transport', transportKind);
  base.hash = hash.toString();
  const url = base.toString();
  $('#sensor-url').textContent = url;
  $('#room-code').textContent = room;
  try {
    const qr = globalThis.qrcode(0, 'M');
    qr.addData(url); qr.make();
    $('#qr').innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  } catch (e) { $('#qr').textContent = 'QR 產生失敗'; }

  try {
    app.link = createLink({ kind: transportKind, room, role: 'host' });
  } catch (e) {
    setLinkStatus('無法建立連線服務：' + e.message, 'err');
    return;
  }
  app.link.on('status', (s) => { if (s === 'waiting') setLinkStatus('等待手機連線…（代碼 ' + room + '）'); });
  app.link.on('error', (e) => {
    const t = e?.type || e?.message || String(e);
    if (t === 'unavailable-id') setLinkStatus('代碼已被使用（可能另一個分頁開著）。請關閉其他分頁或重新整理。', 'err');
    else setLinkStatus('連線錯誤：' + t, 'err');
  });
  app.link.on('open', () => { setLinkStatus('手機已連線，等待相機…', 'ok'); app.link.send({ t: 'phase', phase: 'idle', text: '已連線。請在手機上開啟相機。' }); });
  app.link.on('close', () => { app.sensorReady = false; setLinkStatus('手機連線中斷', 'err'); updateStart(); });
  app.link.on('message', onSensorMessage);
}

function onSensorMessage(m) {
  if (m.t === 'hello') {
    app.sensorReady = !!(m.camera || m.virtual);
    const cam = m.camera ? `${m.camera.label || '相機'} ${m.camera.settings?.width || ''}×${m.camera.settings?.height || ''}` : m.virtual ? '虛擬感測器' : '相機尚未開啟';
    $('#sensor-info').textContent = `手機：${cam}${m.facing === 'user' ? '（前鏡頭）' : ''}`;
    setLinkStatus(app.sensorReady ? '手機已就緒' : '手機已連線，請在手機上開啟相機', app.sensorReady ? 'ok' : '');
    updateStart();
  } else if (m.t === 'live') {
    app.live = { ...m, at: performance.now() };
    if (!app.sensorReady) { app.sensorReady = true; updateStart(); }
  } else if (m.t === 'reading' || m.t === 'reading-error') {
    const p = app.pending.get(m.id);
    if (p) { app.pending.delete(m.id); m.t === 'reading' ? p.resolve(m) : p.reject(new Error(m.error)); }
  }
}

function updateStart() {
  const ok = app.sensorReady || app.sim;
  $('#btn-start').disabled = !ok;
  $('#start-hint').textContent = ok ? (app.sim ? '模擬器模式：不需要手機' : '準備好了') : '請先連線 iPhone（或使用模擬器）';
}

$('#btn-sim').addEventListener('click', () => {
  // A plausible "uncalibrated" monitor: channels with different gamma → grey tracking error.
  app.sim = simulatedSensor({
    display: new VirtualDisplay({ gamma: { r: 2.38, g: 2.2, b: 2.02 }, offset: { r: 0.02, g: 0, b: -0.02 } }),
    camera: new VirtualCamera({ seed: Date.now() & 0xffff }),
    msPerReading: 600,
  });
  $('#sensor-info').textContent = '模擬器：虛擬螢幕 R/G/B gamma = 2.38 / 2.20 / 2.02，虛擬相機含非線性、自動曝光、雜訊與環境光';
  setLinkStatus('模擬器模式', 'ok');
  updateStart();
});

// ------------------------------------------------------------------ measuring
function measureOpts() {
  return { settleMs: parseInt($('#set-settle').value, 10) || 300, frames: parseInt($('#set-frames').value, 10) || 8, maxFrames: 40, tol: 0.003 };
}

async function hostMeasure(stim) {
  if (app.abort?.signal.aborted) throw new DOMException('aborted', 'AbortError');
  await app.stage.show(stim);
  if (app.sim) { await sleep(25); return app.sim(stim); }
  await sleep(40); // LCD response time margin after the frame is presented
  for (let attempt = 0; attempt < 3; attempt++) {
    const id = ++app.seq;
    const p = new Promise((resolve, reject) => {
      app.pending.set(id, { resolve, reject });
      setTimeout(() => { if (app.pending.delete(id)) reject(new Error('timeout')); }, 12000);
    });
    app.link.send({ t: 'measure', id, stim, opts: measureOpts() });
    try {
      const r = await p;
      if (stim.type === 'dither') app.ditherCv.push(r.cv || 0);
      return r;
    } catch (e) {
      if (attempt === 2) throw e;
      app.stage.setInfo('讀值逾時，重試中…（請確認手機仍在線、未鎖定螢幕）');
      await sleep(800);
    }
  }
}

function phaseToPhone(phase, text) { app.link?.send({ t: 'phase', phase, text }); }

async function positioning() {
  // Show the 50 % white dither and wait for a usable, stable camera signal.
  const stim = { type: 'dither', channel: 'w', k: 1, n: 2, geometry: 'rows', block: 1, hi: 255, lo: 0 };
  await app.stage.show(stim);
  if (app.sim) { app.stage.setBig(''); return; }
  phaseToPhone('positioning', '把鏡頭貼在電腦螢幕框內中央');
  let goodSince = null;
  return new Promise((resolve, reject) => {
    const onKey = (e) => { if (e.code === 'Space') { cleanup(); resolve(); } };
    const timer = setInterval(() => {
      if (app.abort.signal.aborted) { cleanup(); reject(new DOMException('aborted', 'AbortError')); return; }
      const l = app.live;
      let msg = '把 iPhone 鏡頭輕貼在框內中央…', ok = false;
      if (l && performance.now() - l.at < 1500) {
        const lvl = (l.mean[0] + l.mean[1] + l.mean[2]) / 3;
        if (Math.max(...l.clip) > 0.02) msg = '相機過曝：請確認鏡頭貼在色塊上（不要對到框外）';
        else if (lvl < 15) msg = '訊號太暗：鏡頭沒有對準白色色塊';
        else if (l.cv > 0.06) msg = '畫面不均勻：鏡頭再貼近螢幕一點，讓畫面完全模糊';
        else { ok = true; msg = '訊號良好，保持不動…'; }
      } else msg = '等待手機相機畫面…';
      if (ok) { goodSince ??= performance.now(); } else goodSince = null;
      const left = goodSince ? Math.max(0, 3 - (performance.now() - goodSince) / 1000) : null;
      app.stage.setBig(`<p>${msg}</p>${left != null ? `<p class="count">${left.toFixed(1)} 秒後開始</p>` : '<p class="small">或按空白鍵直接開始 · Esc 取消</p>'}`);
      if (goodSince && performance.now() - goodSince > 3000) { cleanup(); resolve(); }
    }, 150);
    function cleanup() { clearInterval(timer); window.removeEventListener('keydown', onKey); app.stage.setBig(''); }
    window.addEventListener('keydown', onKey);
  });
}

async function withStage(fn) {
  app.abort = new AbortController();
  const onEsc = (e) => { if (e.key === 'Escape') app.abort.abort(); };
  window.addEventListener('keydown', onEsc);
  document.addEventListener('fullscreenchange', onFsChange);
  function onFsChange() { if (!document.fullscreenElement && !app.stage.root.hidden && !app.sim) app.abort.abort(); }
  const geo = await app.stage.enter();
  app.stage.layout({ patchFrac: parseFloat($('#set-patch').value), background: parseInt($('#set-bg').value, 10) });
  app.dprAtRun = geo.dpr;
  app.ditherCv = [];
  try {
    await positioning();
    phaseToPhone('measuring', '量測中，請勿移動手機');
    return await fn(app.abort.signal);
  } finally {
    window.removeEventListener('keydown', onEsc);
    document.removeEventListener('fullscreenchange', onFsChange);
    phaseToPhone('idle', '量測結束');
    await app.stage.exit();
  }
}

const CH_NAME = { r: '紅', g: '綠', b: '藍', w: '白' };
function progressUI(p) {
  const pct = p.total ? (p.index / p.total) * 100 : 0;
  const t = p.task ? `${CH_NAME[p.task.channel]}色通道 ${p.task.k}/${p.task.n}${p.task.kind === 'consistency' ? `（一致性檢查：${p.task.geometry}）` : p.task.kind === 'drift' ? '（漂移檢查）' : ''}` : '完成';
  app.stage.setInfo(`${Math.round(pct)}% · ${t} · Esc 中止`);
  $('#progress').hidden = false;
  $('#progress .bar').style.width = pct + '%';
  $('#progress .ptext').textContent = `${Math.round(pct)}% ${t}`;
  app.link?.send({ t: 'phase', phase: 'measuring', text: `量測中 ${Math.round(pct)}%` });
}

$('#btn-start').addEventListener('click', async () => {
  $('#btn-start').disabled = true;
  try {
    const raw = await withStage((signal) => runCharacterisation({
      measure: hostMeasure, mode: $('#set-mode').value, block: parseInt($('#set-block').value, 10), signal, onProgress: progressUI,
    }));
    raw.environment = {
      dpr: app.dprAtRun, screen: `${screen.width}×${screen.height}`, ua: navigator.userAgent,
      simulated: !!app.sim, ditherCvMax: Math.max(0, ...app.ditherCv), settings: settings(),
    };
    if (app.sim) raw.environment.truth = simTruth();
    app.raw = raw; app.verify = null;
    store.set('raw', raw); store.set('verify', null);
    recompute();
    $('#step-results').scrollIntoView({ behavior: 'smooth' });
  } catch (e) {
    if (e.name === 'AbortError') alert('量測已中止。'); else { console.error(e); alert('量測失敗：' + e.message); }
  } finally {
    $('#progress').hidden = true;
    updateStart();
  }
});

$('#btn-verify').addEventListener('click', async () => {
  if (!app.analysis) return;
  try {
    const ver = await withStage((signal) => runVerification({ measure: hostMeasure, models: app.analysis.models, signal, onProgress: progressUI }));
    app.verify = ver; store.set('verify', ver);
    renderVerification();
  } catch (e) {
    if (e.name !== 'AbortError') alert('驗證失敗：' + e.message);
  } finally { $('#progress').hidden = true; }
});

function simTruth() {
  const d = app.sim.display;
  return { gamma: d.gamma, offset: d.offset };
}

// ------------------------------------------------------------------ results
const WARN_TEXT = {
  pattern_consistency: (w) => `${CH_NAME[w.channel]}色通道：不同格紋排列的結果相差 ${w.value.toFixed(1)}%（> ${LIMITS.consistencyWarnPct}%）。可能是螢幕相鄰像素互相干擾（串擾）或畫面被縮放重新取樣。建議：瀏覽器縮放 100%、macOS 用「預設」解析度，或把像素區塊改為 2 後重測。`,
  noisy_points: (w) => `${CH_NAME[w.channel]}色通道有 ${w.value} 個點雜訊偏高（手機可能有移動、環境光變化或螢幕 PWM 閃爍）。`,
  bad_points: (w) => `${CH_NAME[w.channel]}色通道有 ${w.value} 個點未能可靠配對，結果可能不準。請確認鏡頭對準色塊並遮光後重測。`,
  drift: (w) => `量測期間螢幕亮度漂移 ${w.value.toFixed(2)}%（> ${LIMITS.driftWarnPct}%）。螢幕可能尚未暖機完成，或有自動亮度/節能功能未關閉。`,
};

function recompute() {
  if (!app.raw) return;
  try {
    app.analysis = analyse(app.raw, analysisOptions());
  } catch (e) { console.error(e); alert('分析失敗：' + e.message); return; }
  renderResults();
}

function fmt(v, d = 2) { return Number.isFinite(v) ? v.toFixed(d) : '—'; }

function renderResults() {
  const A = app.analysis, raw = app.raw;
  $('#step-results').hidden = false;
  const tiles = [];
  tiles.push(`<div class="tile"><div class="k">有效 Gamma（R / G / B）</div><div class="v">${['r', 'g', 'b'].map((c) => fmt(A.channelStats[c].gamma)).join(' / ')}</div><div class="s">各通道差異越大，灰階偏色越明顯</div></div>`);
  tiles.push(`<div class="tile"><div class="k">灰階 ΔE2000（估計）</div><div class="v">${fmt(A.summaryBefore.maxDE, 1)} → ${fmt(A.summaryAfter.maxDE, 1)}</div><div class="s">最大值，校正前 → 校正後（8-bit LUT）。平均 ${fmt(A.summaryBefore.meanDE, 1)} → ${fmt(A.summaryAfter.meanDE, 1)}</div></div>`);
  tiles.push(`<div class="tile"><div class="k">量測期間漂移</div><div class="v">${fmt(A.driftPct)}%</div><div class="s">首尾重測同一點的亮度差（< ${LIMITS.driftWarnPct}% 為佳）</div></div>`);
  const maxCons = Math.max(...['r', 'g', 'b'].map((c) => A.channelStats[c].maxConsistencyPct || 0));
  tiles.push(`<div class="tile"><div class="k">格紋一致性</div><div class="v">${raw.consistency?.r?.length ? fmt(maxCons, 1) + '%' : '—'}</div><div class="s">不同點陣排列的最大差異（< ${LIMITS.consistencyWarnPct}% 為佳）</div></div>`);
  $('#summary').innerHTML = tiles.join('');

  const warns = A.warnings.filter((w) => WARN_TEXT[w.code]).map((w) => `<div class="warn ${w.level}"><b>${w.level === 'warn' ? '⚠ 注意' : 'ℹ 提示'}</b> ${WARN_TEXT[w.code](w)}</div>`);
  if ((raw.environment?.ditherCvMax || 0) > 0.06) warns.push(`<div class="warn warn"><b>⚠ 注意</b> 相機在部分格紋上看到不均勻的畫面（CV ${fmt(raw.environment.ditherCvMax, 3)}），代表格紋沒有被完全模糊平均。請讓鏡頭更貼近螢幕。</div>`);
  if (raw.environment?.dpr && Math.abs(raw.environment.dpr - Math.round(raw.environment.dpr)) > 0.01) warns.push(`<div class="warn warn"><b>⚠ 注意</b> 量測時 devicePixelRatio = ${raw.environment.dpr}（非整數），格紋可能被重新取樣。</div>`);
  if (raw.environment?.simulated && raw.environment.truth) {
    const t = raw.environment.truth.gamma;
    warns.push(`<div class="warn info"><b>ℹ 模擬器</b> 這是模擬結果。虛擬螢幕真實 gamma（GOG 模型）R/G/B = ${t.r} / ${t.g} / ${t.b}；可與上方量測值比對。</div>`);
  }
  warns.push(`<div class="warn info"><b>ℹ 說明</b> ΔE 是以「所選原色 + 量測到的各通道曲線」計算的估計值。相機量測不到原色與白點的絕對色度，因此 ΔE 主要反映<b>灰階平衡與色調曲線</b>的改善，不代表絕對色準。</div>`);
  $('#warnings').innerHTML = warns.join('');

  // charts
  const xs = Array.from({ length: 52 }, (_, i) => i * 5);
  lineChart($('#chart-trc'), {
    title: '色調響應', x: [0, 255], y: [0, 1], xLabel: '輸入值', yLabel: '相對亮度',
    series: [
      { id: 'target', points: xs.map((l) => [l, A.target(l / 255)]) },
      ...['r', 'g', 'b'].map((c) => ({ id: c, points: xs.map((l) => [l, A.models[c].forward(l / 255)]), markers: raw.points[c].map((p) => [p.level, p.rel]) })),
    ],
  });
  const tg = (l) => Math.log(A.target(l / 255)) / Math.log(l / 255);
  const gx = xs.filter((l) => l >= 20 && l <= 245);
  const allG = ['r', 'g', 'b'].flatMap((c) => A.channelStats[c].points.map((p) => p.pointGamma)).filter(Number.isFinite);
  lineChart($('#chart-gamma'), {
    title: '有效 Gamma', x: [0, 255], y: [Math.min(1.6, ...allG) - 0.1, Math.max(2.8, ...allG) + 0.1], xLabel: '輸入值', yLabel: 'Gamma', fmtY: (v) => v.toFixed(2),
    series: [
      { id: 'target', points: gx.map((l) => [l, tg(l)]) },
      ...['r', 'g', 'b'].map((c) => ({ id: c, points: A.channelStats[c].points.filter((p) => Number.isFinite(p.pointGamma)).sort((a, b) => a.level - b.level).map((p) => [p.level, p.pointGamma]), markers: A.channelStats[c].points.map((p) => [p.level, p.pointGamma]).filter((p) => Number.isFinite(p[1])) })),
    ],
  });
  const maxDE = Math.max(1, ...A.grayBefore.map((r) => r.dE));
  lineChart($('#chart-de'), {
    title: '灰階 ΔE2000', x: [0, 255], y: [0, Math.ceil(maxDE)], xLabel: '灰階輸入值', yLabel: 'ΔE2000', fmtY: (v) => v.toFixed(2),
    series: [
      { id: 'before', points: A.grayBefore.map((r) => [r.level, r.dE]), markers: A.grayBefore.map((r) => [r.level, r.dE]) },
      { id: 'after', points: A.grayAfter.map((r) => [r.level, r.dE]), markers: A.grayAfter.map((r) => [r.level, r.dE]) },
    ],
  });
  lineChart($('#chart-lut'), {
    title: '校正曲線', x: [0, 255], y: [0, 255], xLabel: '輸入值', yLabel: '輸出到螢幕的值', fmtY: (v) => v.toFixed(1),
    series: [
      { id: 'target', name: '不變', points: [[0, 0], [255, 255]] },
      ...['r', 'g', 'b'].map((c) => ({ id: c, points: Array.from(A.lut[c], (v, i) => [i, v * 255]).filter((_, i) => i % 3 === 0 || i === 255) })),
    ],
  });

  // table
  const rows = ['r', 'g', 'b'].flatMap((c) => A.channelStats[c].points.map((p) => `<tr><td>${CH_NAME[c]}</td><td>${p.k}/${p.n}</td><td>${p.geometry}</td><td>${fmt(p.rel * 100, 2)}%</td><td>${fmt(p.level, 2)}</td><td>±${fmt(p.se, 2)}</td><td>${fmt(p.pointGamma, 3)}</td><td>${p.evals}</td><td>${(p.flags || []).join(', ')}</td></tr>`));
  const cons = ['r', 'g', 'b'].flatMap((c) => A.channelStats[c].consistency.map((q) => `<tr><td>${CH_NAME[c]}</td><td>${q.k}/${q.n}</td><td>${q.geometry} ×${q.block}</td><td colspan="2">${fmt(q.level, 2)}</td><td>±${fmt(q.se, 2)}</td><td colspan="3">與主要量測差 ${fmt(q.deltaPct, 2)}%</td></tr>`));
  $('#table').innerHTML = `<table><thead><tr><th>通道</th><th>比例</th><th>排列</th><th>目標亮度</th><th>配對輸入值</th><th>標準誤</th><th>點 Gamma</th><th>比較次數</th><th>旗標</th></tr></thead><tbody>${rows.join('')}${cons.length ? '<tr><th colspan="9">一致性檢查</th></tr>' + cons.join('') : ''}</tbody></table>`;
  renderVerification();
}

function renderVerification() {
  const el = $('#verify-result');
  if (!app.verify || !app.analysis) { el.innerHTML = ''; return; }
  const v = verificationSummary(app.verify, app.analysis);
  const pass = v.maxAbsErrPct < 2 && v.maxDE < 1;
  el.innerHTML = `<div class="warn ${pass ? 'ok' : 'warn'}"><b>${pass ? '✓ 通過' : '⚠ 偏差偏大'}</b> 交叉驗證最大亮度誤差 ${fmt(v.maxAbsErrPct)}%，灰階 ΔE2000 估計 平均 ${fmt(v.meanDE)} / 最大 ${fmt(v.maxDE)}。${pass ? '' : '建議檢查遮光、手機是否移動、螢幕是否暖機完成後重新量測。'}</div>
  <table><thead><tr><th>目標亮度</th><th>R 誤差</th><th>G 誤差</th><th>B 誤差</th><th>ΔE2000</th></tr></thead><tbody>${v.rows.map((r) => `<tr><td>${fmt(r.rel * 100, 1)}%</td>${r.errorsPct.map((e) => `<td>${fmt(e)}%</td>`).join('')}<td>${fmt(r.dE)}</td></tr>`).join('')}</tbody></table>`;
}

function download(bytes, name, type) {
  const blob = new Blob([bytes], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
function profileName() {
  const d = new Date();
  return `iPhoneCal_${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}_${app.analysis.targetId}`;
}
$('#dl-cal').addEventListener('click', () => { const p = buildProfiles(app.analysis); download(p.calibrated, profileName() + '.icc', 'application/vnd.iccprofile'); });
$('#dl-prof').addEventListener('click', () => { const p = buildProfiles(app.analysis); download(p.profileOnly, profileName() + '_profile.icc', 'application/vnd.iccprofile'); });
$('#dl-json').addEventListener('click', () => download(JSON.stringify({ raw: app.raw, verify: app.verify }, null, 2), profileName() + '.json', 'application/json'));
$('#import-json').addEventListener('change', async (e) => {
  const f = e.target.files[0]; if (!f) return;
  try {
    const j = JSON.parse(await f.text());
    app.raw = j.raw || j; app.verify = j.verify || null;
    store.set('raw', app.raw); store.set('verify', app.verify);
    recompute();
  } catch (err) { alert('無法讀取：' + err.message); }
});

// ------------------------------------------------------------------ boot
setupLink();
updateStart();
if (app.raw) recompute();
window.__imcal = app; // for debugging / automated tests
