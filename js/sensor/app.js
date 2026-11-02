import { createLink } from '../common/transport.js';
import { FrameSampler, collectReading, onEachFrame } from './capture.js';
import { VirtualDisplay, VirtualCamera } from '../core/simulator.js';

const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.hash.slice(1) || location.search.slice(1));
const qs = new URLSearchParams(location.search);
const transportKind = params.get('transport') || qs.get('transport') || 'peer';
const virtual = (params.get('virtual') || qs.get('virtual')) === '1';

const state = { link: null, stream: null, video: $('#video'), sampler: null, facing: 'environment', deviceId: null, busy: false, wakeLock: null, blackout: false };

function setStatus(text, kind = '') {
  const el = $('#status');
  el.textContent = text;
  el.dataset.kind = kind;
}

function log(msg) {
  const el = $('#log');
  const line = document.createElement('div');
  line.textContent = new Date().toLocaleTimeString() + '  ' + msg;
  el.prepend(line);
  while (el.childElementCount > 40) el.lastChild.remove();
}

// ---------------- connection ----------------
function connect(room) {
  room = (room || '').trim().toLowerCase();
  if (!room) return;
  try { localStorage.setItem('imcal-room', room); } catch {}
  $('#room-code').textContent = room;
  setStatus('連線中…', 'busy');
  try {
    state.link = createLink({ kind: transportKind, room, role: 'sensor' });
  } catch (e) {
    setStatus('無法建立連線：' + e.message, 'err');
    return;
  }
  state.link.on('open', () => {
    setStatus('已連線到電腦', 'ok');
    $('#connect-card').hidden = true;
    sendHello();
  });
  state.link.on('close', () => setStatus('連線中斷，請重新掃描 QR code', 'err'));
  state.link.on('error', (e) => { setStatus('連線錯誤：' + (e.type || e.message || e), 'err'); log('error ' + (e.type || e.message)); });
  state.link.on('status', (s) => log('signalling: ' + s));
  state.link.on('message', onMessage);
}

function sendHello() {
  const track = state.stream?.getVideoTracks?.()[0];
  let caps = {};
  try { caps = track?.getCapabilities?.() || {}; } catch {}
  state.link?.send({
    t: 'hello', ua: navigator.userAgent, virtual,
    camera: track ? { label: track.label, settings: track.getSettings?.(), caps: Object.keys(caps) } : null,
    facing: state.facing,
  });
}

async function onMessage(m) {
  if (m.t === 'ping') { state.link.send({ t: 'pong', ts: m.ts }); return; }
  if (m.t === 'phase') { setPhase(m.phase, m.text); return; }
  if (m.t === 'measure') {
    try {
      const r = await measure(m);
      state.link.send({ t: 'reading', id: m.id, ...r });
    } catch (e) {
      state.link.send({ t: 'reading-error', id: m.id, error: String(e.message || e) });
    }
  }
}

function setPhase(phase, text) {
  $('#phase').textContent = text || '';
  const measuring = phase === 'measuring';
  document.body.classList.toggle('measuring', measuring);
  // Front camera: the phone screen faces the monitor, its light would reflect into the camera.
  state.blackout = measuring && state.facing === 'user';
  document.body.classList.toggle('blackout', state.blackout);
}

// ---------------- measurement ----------------
let virt = null;
async function measure(m) {
  if (virtual) {
    virt ||= { display: new VirtualDisplay(), camera: new VirtualCamera({ seed: 9 }) };
    await new Promise((r) => setTimeout(r, 30));
    return { ...virt.camera.capture(virt.display.stimulusXYZ(m.stim)), cv: 0.002 };
  }
  if (!state.sampler) throw new Error('camera not started');
  return collectReading(state.video, state.sampler, m.opts || {});
}

// ---------------- camera ----------------
async function startCamera() {
  if (virtual) { setStatus('虛擬感測器模式（測試用）', 'ok'); $('#camera-card').hidden = true; sendHello(); return; }
  stopCamera();
  const video = state.video;
  const constraints = {
    audio: false,
    video: state.deviceId
      ? { deviceId: { exact: state.deviceId }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } }
      : { facingMode: { ideal: state.facing }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
  };
  try {
    state.stream = await navigator.mediaDevices.getUserMedia(constraints);
  } catch (e) {
    setStatus('無法開啟相機：' + e.message + '（請允許相機權限，且需 HTTPS）', 'err');
    return;
  }
  video.srcObject = state.stream;
  await video.play().catch(() => {});
  const track = state.stream.getVideoTracks()[0];
  const settings = track.getSettings?.() || {};
  state.facing = settings.facingMode || state.facing;
  document.body.classList.toggle('mirror', state.facing === 'user');
  try { await track.applyConstraints({ advanced: [{ torch: false }] }); } catch {}
  state.sampler = new FrameSampler(video);
  $('#cam-info').textContent = `${track.label || '相機'} · ${settings.width}×${settings.height} @ ${Math.round(settings.frameRate || 0)} fps`;
  let caps = {};
  try { caps = track.getCapabilities?.() || {}; } catch {}
  const interesting = ['exposureMode', 'whiteBalanceMode', 'focusMode', 'exposureCompensation', 'torch', 'zoom'].filter((k) => k in caps);
  $('#cam-caps').textContent = interesting.length ? '相機可調參數：' + interesting.join(', ') : '此瀏覽器未提供手動曝光/白平衡控制（本方法不需要）';
  await listCameras();
  startLive();
  requestWakeLock();
  sendHello();
}

function stopCamera() {
  state.stream?.getTracks().forEach((t) => t.stop());
  state.stream = null;
  state.sampler = null;
}

async function listCameras() {
  const sel = $('#camera-select');
  try {
    const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
    sel.innerHTML = '';
    for (const d of devs) {
      const o = document.createElement('option');
      o.value = d.deviceId; o.textContent = d.label || `相機 ${sel.length + 1}`;
      if (state.stream?.getVideoTracks()[0]?.getSettings?.().deviceId === d.deviceId) o.selected = true;
      sel.append(o);
    }
  } catch {}
}

let stopLive = null;
function startLive() {
  stopLive && stopLive();
  let last = 0;
  stopLive = onEachFrame(state.video, () => {
    const now = performance.now();
    if (now - last < 250 || !state.sampler) return;
    last = now;
    const s = state.sampler.sample();
    if (!s) return;
    const [r, g, b] = s.mean.map((v) => Math.round(v));
    $('#live-rgb').textContent = `R ${r}  G ${g}  B ${b}`;
    $('#live-swatch').style.background = `rgb(${r},${g},${b})`;
    const clipped = Math.max(...s.clip) > 0.02;
    const level = (s.mean[0] + s.mean[1] + s.mean[2]) / 3;
    $('#live-hint').textContent = clipped ? '⚠ 部分像素過曝' : level < 8 ? '訊號很暗：請把鏡頭對準白色圓形區域' : s.cv > 0.08 ? '畫面不均勻：鏡頭再貼近一點（要模糊才對）' : '訊號良好';
    state.link?.send({ t: 'live', mean: s.mean, clip: s.clip, cv: s.cv });
  });
}

async function requestWakeLock() {
  try {
    state.wakeLock = await navigator.wakeLock?.request('screen');
  } catch {}
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.stream) requestWakeLock();
});

// ---------------- UI wiring ----------------
$('#btn-connect').addEventListener('click', () => connect($('#room-input').value));
$('#btn-camera').addEventListener('click', startCamera);
$('#btn-flip').addEventListener('click', () => { state.facing = state.facing === 'user' ? 'environment' : 'user'; state.deviceId = null; startCamera(); });
$('#camera-select').addEventListener('change', (e) => { state.deviceId = e.target.value; startCamera(); });
document.body.addEventListener('click', () => { if (state.blackout) document.body.classList.toggle('peek'); });

if (!window.isSecureContext) setStatus('此頁必須以 HTTPS 開啟才能使用相機', 'err');
const room = params.get('room') || qs.get('room');
if (room) { $('#room-input').value = room; connect(room); }
else { const saved = (() => { try { return localStorage.getItem('imcal-room'); } catch { return null; } })(); if (saved) $('#room-input').value = saved; }
if (virtual) startCamera();
