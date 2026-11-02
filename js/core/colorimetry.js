// Colorimetry helpers (pure functions, no DOM).
// References: CIE 15:2018 (colorimetry), IEC 61966-2-1 (sRGB),
// Sharma, Wu & Dalal (2005) for CIEDE2000, Lam/Hunt Bradford CAT as used in ICC.1 Annex.

export const ILLUMINANTS = {
  // CIE 1931 2° chromaticities
  D65: { x: 0.3127, y: 0.3290 },
  D50: { x: 0.3457, y: 0.3585 },
};

// ICC PCS illuminant (exact s15Fixed16-representable values used by ICC.1)
export const ICC_D50_XYZ = [0.9642, 1.0, 0.8249];

export const PRIMARY_PRESETS = {
  srgb: {
    name: 'sRGB / BT.709 (一般辦公/大多數螢幕)',
    r: { x: 0.64, y: 0.33 }, g: { x: 0.30, y: 0.60 }, b: { x: 0.15, y: 0.06 }, w: ILLUMINANTS.D65,
  },
  p3: {
    name: 'Display P3 (Apple / 廣色域 DCI-P3 D65)',
    r: { x: 0.680, y: 0.320 }, g: { x: 0.265, y: 0.690 }, b: { x: 0.150, y: 0.060 }, w: ILLUMINANTS.D65,
  },
  adobergb: {
    name: 'Adobe RGB (1998) (攝影/印刷廣色域螢幕)',
    r: { x: 0.64, y: 0.33 }, g: { x: 0.21, y: 0.71 }, b: { x: 0.15, y: 0.06 }, w: ILLUMINANTS.D65,
  },
  bt2020: {
    name: 'BT.2020 (極廣色域，少見)',
    r: { x: 0.708, y: 0.292 }, g: { x: 0.170, y: 0.797 }, b: { x: 0.131, y: 0.046 }, w: ILLUMINANTS.D65,
  },
};

export function xyToXYZ({ x, y }, Y = 1) {
  return [(x * Y) / y, Y, ((1 - x - y) * Y) / y];
}

export function XYZtoxy([X, Y, Z]) {
  const s = X + Y + Z;
  if (s === 0) return { x: 0, y: 0 };
  return { x: X / s, y: Y / s };
}

export function XYZtoUpVp([X, Y, Z]) {
  const d = X + 15 * Y + 3 * Z;
  if (d === 0) return { u: 0, v: 0 };
  return { u: (4 * X) / d, v: (9 * Y) / d };
}

// ---- small 3x3 linear algebra ----
export function matMul(A, B) {
  const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    C[i][j] = A[i][0] * B[0][j] + A[i][1] * B[1][j] + A[i][2] * B[2][j];
  }
  return C;
}

export function matVec(A, v) {
  return [
    A[0][0] * v[0] + A[0][1] * v[1] + A[0][2] * v[2],
    A[1][0] * v[0] + A[1][1] * v[1] + A[1][2] * v[2],
    A[2][0] * v[0] + A[2][1] * v[1] + A[2][2] * v[2],
  ];
}

export function matInv(m) {
  const [a, b, c] = m[0], [d, e, f] = m[1], [g, h, i] = m[2];
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-15) throw new Error('singular matrix');
  return [
    [A / det, -(b * i - c * h) / det, (b * f - c * e) / det],
    [B / det, (a * i - c * g) / det, -(a * f - c * d) / det],
    [C / det, -(a * h - b * g) / det, (a * e - b * d) / det],
  ];
}

export function diag(v) {
  return [[v[0], 0, 0], [0, v[1], 0], [0, 0, v[2]]];
}

// RGB(linear) -> XYZ matrix for given primaries & white (white Y = 1).
// Columns are the XYZ of R, G, B at full drive.
export function rgbToXYZMatrix(prim) {
  const P = [xyToXYZ(prim.r), xyToXYZ(prim.g), xyToXYZ(prim.b)];
  const M = [[P[0][0], P[1][0], P[2][0]], [P[0][1], P[1][1], P[2][1]], [P[0][2], P[1][2], P[2][2]]];
  const W = xyToXYZ(prim.w);
  const S = matVec(matInv(M), W);
  return matMul(M, diag(S));
}

// Bradford chromatic adaptation (as recommended in ICC.1 Annex E for 'chad').
export const BRADFORD = [
  [0.8951, 0.2664, -0.1614],
  [-0.7502, 1.7135, 0.0367],
  [0.0389, -0.0685, 1.0296],
];

export function bradfordMatrix(srcWhiteXYZ, dstWhiteXYZ) {
  const s = matVec(BRADFORD, srcWhiteXYZ);
  const d = matVec(BRADFORD, dstWhiteXYZ);
  return matMul(matInv(BRADFORD), matMul(diag([d[0] / s[0], d[1] / s[1], d[2] / s[2]]), BRADFORD));
}

// ---- CIELAB & CIEDE2000 ----
export function XYZtoLab([X, Y, Z], white) {
  const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const fx = f(X / white[0]), fy = f(Y / white[1]), fz = f(Z / white[2]);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

const deg = (r) => (r * 180) / Math.PI;
const rad = (d) => (d * Math.PI) / 180;

// CIEDE2000 colour difference (kL = kC = kH = 1), following Sharma, Wu & Dalal (2005).
export function deltaE2000(lab1, lab2) {
  const [L1, a1, b1] = lab1, [L2, a2, b2] = lab2;
  const C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2);
  const Cb = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cb ** 7 / (Cb ** 7 + 25 ** 7)));
  const a1p = (1 + G) * a1, a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1), C2p = Math.hypot(a2p, b2);
  const hp = (a, b) => {
    if (a === 0 && b === 0) return 0;
    const h = deg(Math.atan2(b, a));
    return h >= 0 ? h : h + 360;
  };
  const h1p = hp(a1p, b1), h2p = hp(a2p, b2);
  const dLp = L2 - L1;
  const dCp = C2p - C1p;
  let dhp = 0;
  if (C1p * C2p !== 0) {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin(rad(dhp / 2));
  const Lbp = (L1 + L2) / 2;
  const Cbp = (C1p + C2p) / 2;
  let hbp;
  if (C1p * C2p === 0) hbp = h1p + h2p;
  else if (Math.abs(h1p - h2p) <= 180) hbp = (h1p + h2p) / 2;
  else if (h1p + h2p < 360) hbp = (h1p + h2p + 360) / 2;
  else hbp = (h1p + h2p - 360) / 2;
  const T = 1 - 0.17 * Math.cos(rad(hbp - 30)) + 0.24 * Math.cos(rad(2 * hbp))
    + 0.32 * Math.cos(rad(3 * hbp + 6)) - 0.20 * Math.cos(rad(4 * hbp - 63));
  const dTheta = 30 * Math.exp(-(((hbp - 275) / 25) ** 2));
  const RC = 2 * Math.sqrt(Cbp ** 7 / (Cbp ** 7 + 25 ** 7));
  const SL = 1 + (0.015 * (Lbp - 50) ** 2) / Math.sqrt(20 + (Lbp - 50) ** 2);
  const SC = 1 + 0.045 * Cbp;
  const SH = 1 + 0.015 * Cbp * T;
  const RT = -Math.sin(rad(2 * dTheta)) * RC;
  return Math.sqrt((dLp / SL) ** 2 + (dCp / SC) ** 2 + (dHp / SH) ** 2 + RT * (dCp / SC) * (dHp / SH));
}

// sRGB transfer (IEC 61966-2-1)
export function srgbDecode(v) {
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}
export function srgbEncode(l) {
  return l <= 0.0031308 ? l * 12.92 : 1.055 * l ** (1 / 2.4) - 0.055;
}
