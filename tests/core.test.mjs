import test from 'node:test';
import assert from 'node:assert/strict';
import {
  rgbToXYZMatrix, PRIMARY_PRESETS, bradfordMatrix, xyToXYZ, ICC_D50_XYZ, matMul, deltaE2000,
} from '../js/core/colorimetry.js';
import { monotoneSpline, buildChannelModel, buildCalibrationLUT, targetFunction, isotonic, bt1886 } from '../js/core/curves.js';
import { measuredFraction, renderStimulus } from '../js/core/patterns.js';
import { NullMatcher } from '../js/core/nullsearch.js';
import { VirtualDisplay, VirtualCamera, simulatedSensor } from '../js/core/simulator.js';
import { runCharacterisation, runVerification } from '../js/core/session.js';
import { analyse, buildProfiles, verificationSummary } from '../js/core/analysis.js';
import { parseProfile } from '../js/core/icc.js';

const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} expected ${b}, got ${a} (tol ${tol})`);

test('sRGB RGB→XYZ matrix matches IEC 61966-2-1', () => {
  const M = rgbToXYZMatrix(PRIMARY_PRESETS.srgb);
  const ref = [[0.4124, 0.3576, 0.1805], [0.2126, 0.7152, 0.0722], [0.0193, 0.1192, 0.9505]];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) close(M[i][j], ref[i][j], 6e-4);
});

test('Bradford-adapted sRGB colorants match the ICC sRGB profile', () => {
  const M = rgbToXYZMatrix(PRIMARY_PRESETS.srgb);
  const A = bradfordMatrix(xyToXYZ(PRIMARY_PRESETS.srgb.w), ICC_D50_XYZ);
  const D = matMul(A, M);
  const ref = [[0.4361, 0.3851, 0.1431], [0.2225, 0.7169, 0.0606], [0.0139, 0.0971, 0.7141]];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) close(D[i][j], ref[i][j], 1.5e-3);
});

test('CIEDE2000 reproduces Sharma, Wu & Dalal (2005) test pairs', () => {
  const rows = [
    [[50, 2.6772, -79.7751], [50, 0, -82.7485], 2.0425],
    [[50, 3.1571, -77.2803], [50, 0, -82.7485], 2.8615],
    [[50, 2.8361, -74.0200], [50, 0, -82.7485], 3.4412],
    [[50, -1.3802, -84.2814], [50, 0, -82.7485], 1.0000],
    [[50, 0, 0], [50, -1, 2], 2.3669],
    [[50, 2.5, 0], [73, 25, -18], 27.1492],
    [[50, 2.5, 0], [61, -5, 29], 22.8977],
    [[50, 2.5, 0], [56, -27, -3], 31.9030],
    [[50, 2.5, 0], [58, 24, 15], 19.4535],
    [[50, 2.5, 0], [50, 3.1736, 0.5854], 1.0000],
    [[60.2574, -34.0099, 36.2677], [60.4626, -34.1751, 39.4387], 1.2644],
    [[63.0109, -31.0961, -5.8663], [62.8187, -29.7946, -4.0864], 1.2630],
    [[2.0776, 0.0795, -1.1350], [0.9033, -0.0636, -0.5514], 0.9082],
  ];
  for (const [a, b, de] of rows) close(deltaE2000(a, b), de, 1e-4, `${a} vs ${b}`);
});

test('isotonic + monotone spline never decrease', () => {
  assert.deepEqual(isotonic([1, 3, 2, 4]), [1, 2.5, 2.5, 4]);
  const f = monotoneSpline([0, 0.2, 0.5, 0.51, 1], [0, 0.1, 0.5, 0.9, 1]);
  let prev = -Infinity;
  for (let x = 0; x <= 1; x += 0.001) { const v = f(x); assert.ok(v >= prev - 1e-12); prev = v; }
});

test('channel model reproduces a pure power law from 8 match points', () => {
  const g = 2.4;
  const pts = [1 / 16, 1 / 8, 1 / 4, 3 / 8, 1 / 2, 5 / 8, 3 / 4, 7 / 8].map((rel) => ({ rel, level: 255 * rel ** (1 / g) }));
  const m = buildChannelModel(pts);
  for (let x = 0.1; x < 1; x += 0.05) close(m.forward(x) / x ** g, 1, 0.01, `x=${x.toFixed(2)}`);
  for (let r = 0.02; r < 1; r += 0.05) close(m.inverse(r), r ** (1 / g), 0.003);
});

test('BT.1886 normalised target spans 0..1', () => {
  const f = bt1886(1000);
  close(f(0), 0, 1e-12); close(f(1), 1, 1e-12);
  assert.ok(f(0.5) > 0.15 && f(0.5) < 0.25);
});

test('dither patterns have exact duty cycles', () => {
  for (const [k, n] of [[1, 2], [1, 4], [3, 4], [1, 8], [3, 8], [5, 8], [7, 8]]) {
    for (const geometry of ['rows', 'cols']) for (const block of [1, 2]) {
      assert.equal(measuredFraction({ k, n, geometry, block }, 64, 64), k / n);
    }
  }
  assert.equal(measuredFraction({ k: 1, n: 2, geometry: 'checker', block: 1 }, 64, 64), 0.5);
  for (let k = 1; k < 16; k++) assert.equal(measuredFraction({ k, n: 16, geometry: 'bayer', block: 1 }, 64, 64), k / 16);
  for (let k = 1; k < 64; k++) assert.equal(measuredFraction({ k, n: 64, geometry: 'bayer', block: 1 }, 64, 64), k / 64);
});

test('renderStimulus writes the pure primary only', () => {
  const buf = new Uint8ClampedArray(8 * 8 * 4);
  renderStimulus(buf, 8, 8, { type: 'dither', channel: 'g', k: 1, n: 2, geometry: 'rows', block: 1, hi: 255, lo: 0 });
  for (let i = 0; i < 64; i++) { assert.equal(buf[i * 4], 0); assert.equal(buf[i * 4 + 2], 0); }
  assert.equal(buf[1], 255); assert.equal(buf[8 * 4 + 1], 0);
});

test('null matcher finds the luminance match despite a hostile camera', async () => {
  const display = new VirtualDisplay();
  const sensor = simulatedSensor({ display, camera: new VirtualCamera({ seed: 3 }) });
  const matcher = new NullMatcher({ measure: sensor, repeats: 1 });
  for (const c of ['r', 'g', 'b']) {
    const res = await matcher.match({ channel: c, dither: { type: 'dither', channel: c, k: 1, n: 2, geometry: 'rows', block: 1 }, guess: 186 });
    const relAtMatch = display.rel(c, res.level);
    close(relAtMatch, 0.5, 0.004, `channel ${c}`);
  }
});

test('end-to-end: characterisation recovers each channel curve (≤1 % mid/highlights, ≤3 % shadows, ≤8 % below 1/32)', async () => {
  const display = new VirtualDisplay({ gamma: { r: 2.4, g: 2.15, b: 1.95 }, offset: { r: 0.03, g: 0, b: -0.02 }, driftPerMin: 0.001 });
  const sensor = simulatedSensor({ display, camera: new VirtualCamera({ seed: 11 }) });
  const raw = await runCharacterisation({ measure: sensor, mode: 'standard' });
  const A = analyse(raw, { target: 'gamma22', primaries: 'srgb' });
  for (const c of ['r', 'g', 'b']) {
    for (let lvl = 30; lvl <= 250; lvl += 10) {
      const truth = display.rel(c, lvl);
      const est = A.models[c].forward(lvl / 255);
      close(est / truth, 1, lvl < 50 ? 0.08 : lvl < 70 ? 0.03 : 0.01, `${c}@${lvl}`);
    }
  }
  // gray balance after calibration should be far better than before
  assert.ok(A.summaryAfter.maxDE < 1.0, `after max dE ${A.summaryAfter.maxDE}`);
  assert.ok(A.summaryBefore.maxDE > A.summaryAfter.maxDE * 2);
  // verification with geometry not used in the fit
  const ver = await runVerification({ measure: sensor, models: A.models });
  const vs = verificationSummary(ver, A);
  assert.ok(vs.maxAbsErrPct < 2.0, `verification err ${vs.maxAbsErrPct}`);
  // ICC round trip
  const { calibrated, profileOnly } = buildProfiles(A, { date: new Date('2026-01-02T03:04:05Z') });
  const p = parseProfile(calibrated);
  assert.equal(p.size, calibrated.length);
  assert.equal(p.magic, 'acsp');
  assert.equal(p.class, 'mntr');
  assert.equal(p.tags.vcgt.value.count, 256);
  assert.equal(p.tags.rTRC.value.length, 1024);
  close(p.tags.vcgt.value.g[128], A.lut.g[128], 1 / 65535);
  const q = parseProfile(profileOnly);
  close(q.tags.vcgt.value.r[100], 100 / 255, 1 / 65535);
});

test('calibration LUT is monotone and maps 0→0, 1→1 at native white', () => {
  const pts = (g) => [1 / 8, 1 / 4, 1 / 2, 3 / 4].map((rel) => ({ rel, level: 255 * rel ** (1 / g) }));
  const models = { r: buildChannelModel(pts(2.5)), g: buildChannelModel(pts(2.2)), b: buildChannelModel(pts(1.9)) };
  const lut = buildCalibrationLUT(models, targetFunction('gamma22'));
  for (const c of ['r', 'g', 'b']) {
    assert.equal(lut[c][0], 0); close(lut[c][255], 1, 1e-9);
    for (let i = 1; i < 256; i++) assert.ok(lut[c][i] >= lut[c][i - 1]);
  }
  close(lut.g[128], 128 / 255, 0.003);
});

test('white retarget: native 7000K-ish white is scaled to D65 after calibration', async () => {
  const display = new VirtualDisplay();
  const sensor = simulatedSensor({ display, camera: new VirtualCamera({ seed: 2 }) });
  const raw = await runCharacterisation({ measure: sensor, mode: 'quick' });
  const native = { ...PRIMARY_PRESETS.srgb, w: { x: 0.3060, y: 0.3230 } };
  const A = analyse(raw, { target: 'gamma22', primaries: native, retargetWhite: { x: 0.3127, y: 0.3290 } });
  assert.ok(A.scale.b < 1 && A.scale.r === 1, JSON.stringify(A.scale));
  assert.ok(A.summaryBefore.maxDE > 2, 'white error visible before');
  assert.ok(A.summaryAfter.maxDE < 1, `after ${A.summaryAfter.maxDE}`);
});
