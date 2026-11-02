// Turn raw null-method matches into models, calibration curves, quality metrics and ICC profiles.

import { buildChannelModel, buildCalibrationLUT, targetFunction, sampleCurve, pointGamma } from './curves.js';
import { PRIMARY_PRESETS, rgbToXYZMatrix, matVec, matInv, xyToXYZ, XYZtoLab, deltaE2000, XYZtoUpVp } from './colorimetry.js';
import { buildDisplayProfile } from './icc.js';

export const LIMITS = {
  consistencyWarnPct: 2.0,  // pattern-geometry disagreement (luminance %) → pixel interaction / scaling
  driftWarnPct: 1.0,        // display drift during the run
  noisyLevelSe: 0.75,       // match standard error in code values
};

export function resolvePrimaries(sel) {
  if (typeof sel === 'string') return PRIMARY_PRESETS[sel] || PRIMARY_PRESETS.srgb;
  return sel;
}

function relErrPct(model, levelA, levelB) {
  const a = model.forward(levelA / 255), b = model.forward(levelB / 255);
  return ((a - b) / b) * 100;
}

function fitGamma(points) {
  // least-squares single exponent through (x, rel) in log–log space
  let num = 0, den = 0;
  for (const p of points) {
    const x = p.level / 255;
    if (x <= 0.02 || x >= 0.999 || p.rel <= 0 || p.rel >= 1) continue;
    num += Math.log(x) * Math.log(p.rel);
    den += Math.log(x) ** 2;
  }
  return den ? num / den : NaN;
}

export function grayDeviation(relFn, target, M, white = matVec(M, [1, 1, 1]), steps = 20) {
  // relFn(x) -> [r,g,b] black-subtracted relative channel output for grey input x
  // M: physical emission matrix (native channel maxima); white: target white XYZ
  const wUV = XYZtoUpVp(white);
  const rows = [];
  for (let i = 1; i <= steps; i++) {
    const x = i / steps;
    const rgb = relFn(x);
    const xyz = matVec(M, rgb);
    const t = target(x);
    const txyz = white.map((v) => v * t);
    const uv = XYZtoUpVp(xyz);
    const dE = deltaE2000(XYZtoLab(xyz, white), XYZtoLab(txyz, white));
    rows.push({ x, level: Math.round(x * 255), dE, duv: Math.hypot(uv.u - wUV.u, uv.v - wUV.v), Yrel: xyz[1], Ytarget: t });
  }
  return rows;
}

/**
 * @param {object} raw     result of runCharacterisation
 * @param {object} opts    { target:'gamma22'|..., contrast, primaries:'srgb'|{...}, scale:{r,g,b} }
 */
export function analyse(raw, opts = {}) {
  const targetId = opts.target || 'gamma22';
  const target = targetFunction(targetId, { contrast: opts.contrast });
  // Native primaries: chromaticities are ASSUMED (preset / user-entered); the camera cannot measure them.
  const primNative = resolvePrimaries(opts.primaries || 'srgb');
  const M = rgbToXYZMatrix(primNative);
  let scale = { r: 1, g: 1, b: 1 }, profilePrim = primNative;
  if (opts.retargetWhite) {
    // Only meaningful when the native white chromaticity (primNative.w) is a trusted measurement.
    const s = matVec(matInv(M), xyToXYZ(opts.retargetWhite));
    const k = Math.max(...s);
    if (s.every((v) => v > 0)) {
      scale = { r: s[0] / k, g: s[1] / k, b: s[2] / k };
      profilePrim = { ...primNative, w: opts.retargetWhite };
    }
  }
  const whiteT = matVec(M, [scale.r, scale.g, scale.b]);
  const models = {}, channelStats = {};
  const warnings = [];
  for (const c of ['r', 'g', 'b']) {
    const pts = raw.points[c] || [];
    models[c] = buildChannelModel(pts.map((p) => ({ rel: p.rel, level: p.level, weight: Number.isFinite(p.se) ? 1 / Math.max(p.se, 0.05) ** 2 : 1 })));
    const pg = pts.map((p) => ({ ...p, pointGamma: pointGamma(p.level / 255, p.rel) }));
    const cons = (raw.consistency?.[c] || []).map((q) => {
      const main = pts.find((p) => p.k === q.k && p.n === q.n);
      return { ...q, deltaPct: main ? relErrPct(models[c], q.level, main.level) : NaN };
    });
    const maxCons = cons.reduce((m, q) => Math.max(m, Math.abs(q.deltaPct) || 0), 0);
    if (maxCons > LIMITS.consistencyWarnPct) warnings.push({ level: 'warn', code: 'pattern_consistency', channel: c, value: maxCons });
    const noisy = pts.filter((p) => p.se > LIMITS.noisyLevelSe || p.flags?.includes('noisy')).length;
    if (noisy) warnings.push({ level: 'info', code: 'noisy_points', channel: c, value: noisy });
    const bad = pts.filter((p) => p.flags?.some((f) => /unusable|no_bracket|range|non_monotonic/.test(f))).length;
    if (bad) warnings.push({ level: 'warn', code: 'bad_points', channel: c, value: bad });
    channelStats[c] = { points: pg, consistency: cons, gamma: fitGamma(pts), maxConsistencyPct: maxCons };
  }

  let driftPct = NaN;
  if (raw.drift && Number.isFinite(raw.drift.first) && Number.isFinite(raw.drift.last)) {
    driftPct = relErrPct(models[raw.drift.channel], raw.drift.last, raw.drift.first);
    if (Math.abs(driftPct) > LIMITS.driftWarnPct) warnings.push({ level: 'warn', code: 'drift', value: driftPct });
  }

  const lut = buildCalibrationLUT(models, target, scale, 256);

  const before = grayDeviation((x) => ['r', 'g', 'b'].map((c) => models[c].forward(x)), target, M, whiteT);
  const after8 = grayDeviation((x) => ['r', 'g', 'b'].map((c) => {
    const i = Math.round(x * 255);
    const lvl = Math.round(lut[c][i] * 255);
    return models[c].forward(lvl / 255);
  }), target, M, whiteT);

  const summary = (rows) => ({
    meanDE: rows.reduce((s, r) => s + r.dE, 0) / rows.length,
    maxDE: rows.reduce((m, r) => Math.max(m, r.dE), 0),
    maxDuv: rows.reduce((m, r) => Math.max(m, r.duv), 0),
  });

  return {
    targetId, target, primaries: profilePrim, nativePrimaries: primNative, scale, whiteT, M, models, lut, channelStats, warnings, driftPct,
    grayBefore: before, grayAfter: after8,
    summaryBefore: summary(before), summaryAfter: summary(after8),
  };
}

/** Verification summary in ΔE2000 for grey (requires assumed primaries). */
export function verificationSummary(verify, analysis) {
  const M = analysis.M;
  const sc = analysis.scale || { r: 1, g: 1, b: 1 };
  const white = analysis.whiteT || matVec(M, [1, 1, 1]);
  const rows = [];
  const fr = verify.r || [];
  for (let i = 0; i < fr.length; i++) {
    const p = fr[i].rel;
    const e = ['r', 'g', 'b'].map((c) => (verify[c]?.[i]?.errorPct || 0) / 100);
    const actual = matVec(M, e.map((ei, j) => p * (1 + ei) * [sc.r, sc.g, sc.b][j]));
    const tgt = white.map((v) => v * p);
    rows.push({ rel: p, errorsPct: e.map((v) => v * 100), dE: deltaE2000(XYZtoLab(actual, white), XYZtoLab(tgt, white)) });
  }
  const maxAbsErr = Math.max(0, ...Object.values(verify).flat().map((v) => Math.abs(v.errorPct)));
  return { rows, maxAbsErrPct: maxAbsErr, meanDE: rows.reduce((s, r) => s + r.dE, 0) / (rows.length || 1), maxDE: Math.max(0, ...rows.map((r) => r.dE)) };
}

/** Build both ICC variants. */
export function buildProfiles(analysis, { name = 'iPhone Camera Calibrated', date = new Date() } = {}) {
  const ymd = date.toISOString().slice(0, 10);
  const tgt = analysis.target;
  const calibrated = buildDisplayProfile({
    description: `${name} ${ymd} (${analysis.targetId}, vcgt)`,
    primaries: analysis.primaries,
    trc: { r: sampleCurve(tgt), g: sampleCurve(tgt), b: sampleCurve(tgt) },
    vcgt: analysis.lut,
    date,
  });
  const profileOnly = buildDisplayProfile({
    description: `${name} ${ymd} (profile only)`,
    primaries: analysis.nativePrimaries || analysis.primaries,
    trc: { r: sampleCurve(analysis.models.r.forward), g: sampleCurve(analysis.models.g.forward), b: sampleCurve(analysis.models.b.forward) },
    vcgt: null,
    date,
  });
  return { calibrated, profileOnly };
}
