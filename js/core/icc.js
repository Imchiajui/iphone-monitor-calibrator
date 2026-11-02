// Minimal ICC v2.4 display (matrix/TRC) profile writer + reader, with Apple 'vcgt' tag.
// Spec: ICC.1:2001-04 (v2.4) and ICC.1:2022 (v4.4) for 'chad'; 'vcgt' per Apple ColorSync.
// v2 is used for the widest compatibility (Windows WCS/ICM, macOS ColorSync, Argyll, lcms).

import { ICC_D50_XYZ, bradfordMatrix, matVec, rgbToXYZMatrix, matMul, xyToXYZ } from './colorimetry.js';

class Writer {
  constructor() { this.bytes = []; }
  u8(v) { this.bytes.push(v & 0xff); }
  u16(v) { this.u8(v >>> 8); this.u8(v); }
  u32(v) { this.u16((v >>> 16) & 0xffff); this.u16(v & 0xffff); }
  s15f16(v) { const i = Math.round(v * 65536); this.u32(i < 0 ? (i + 0x100000000) >>> 0 : i >>> 0); }
  sig(s) { for (let i = 0; i < 4; i++) this.u8(s.charCodeAt(i)); }
  ascii(s, n) { for (let i = 0; i < n; i++) this.u8(i < s.length ? s.charCodeAt(i) & 0x7f : 0); }
  pad4() { while (this.bytes.length % 4) this.u8(0); }
  get length() { return this.bytes.length; }
  toUint8() { return Uint8Array.from(this.bytes); }
}

function asciiSafe(s) { return String(s).replace(/[^\x20-\x7e]/g, '?'); }

function tagXYZ(xyz) {
  const w = new Writer(); w.sig('XYZ '); w.u32(0); xyz.forEach((v) => w.s15f16(v)); return w.toUint8();
}

function tagText(s) {
  const w = new Writer(); w.sig('text'); w.u32(0); const a = asciiSafe(s); w.ascii(a, a.length + 1); return w.toUint8();
}

// v2 textDescriptionType: ASCII + Unicode (UTF-16BE) + ScriptCode
function tagDesc(s) {
  const w = new Writer();
  w.sig('desc'); w.u32(0);
  const a = asciiSafe(s);
  w.u32(a.length + 1); w.ascii(a, a.length + 1);
  w.u32(0); // unicode language code
  const uni = String(s);
  w.u32(uni.length + 1);
  for (let i = 0; i < uni.length; i++) w.u16(uni.charCodeAt(i));
  w.u16(0);
  w.u16(0); w.u8(0); for (let i = 0; i < 67; i++) w.u8(0); // ScriptCode (empty)
  return w.toUint8();
}

function tagCurve(samples) {
  const w = new Writer();
  w.sig('curv'); w.u32(0);
  w.u32(samples.length);
  for (const v of samples) w.u16(Math.round(Math.min(1, Math.max(0, v)) * 65535));
  return w.toUint8();
}

function tagSf32(mat) {
  const w = new Writer(); w.sig('sf32'); w.u32(0);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) w.s15f16(mat[i][j]);
  return w.toUint8();
}

// Apple video card gamma table (table form, 3 channels, 16-bit entries)
function tagVcgt(lut) {
  const n = lut.r.length;
  const w = new Writer();
  w.sig('vcgt'); w.u32(0);
  w.u32(0);            // gammaType 0 = table
  w.u16(3); w.u16(n); w.u16(2);
  for (const c of ['r', 'g', 'b']) for (let i = 0; i < n; i++) w.u16(Math.round(Math.min(1, Math.max(0, lut[c][i])) * 65535));
  return w.toUint8();
}

/**
 * @param {object} o
 * @param {string} o.description
 * @param {string} [o.copyright]
 * @param {{r,g,b,w}} o.primaries   chromaticities (xy) incl. white
 * @param {{r:ArrayLike<number>,g:ArrayLike<number>,b:ArrayLike<number>}} o.trc  0..1 samples
 * @param {{r,g,b}|null} [o.vcgt]  calibration LUT 0..1 (null → identity table)
 * @param {Date} [o.date]
 * @returns {Uint8Array}
 */
export function buildDisplayProfile({ description, copyright = 'No copyright. Created with iPhone Monitor Calibrator.', primaries, trc, vcgt = null, date = new Date() }) {
  const M = rgbToXYZMatrix(primaries);              // RGB -> XYZ (white Y=1)
  const whiteXYZ = xyToXYZ(primaries.w);
  const chad = bradfordMatrix(whiteXYZ, ICC_D50_XYZ);
  const Md50 = matMul(chad, M);                      // colorants adapted to D50 PCS
  const col = (j) => [Md50[0][j], Md50[1][j], Md50[2][j]];
  const identity = (() => { const a = new Float64Array(256); for (let i = 0; i < 256; i++) a[i] = i / 255; return { r: a, g: a, b: a }; })();

  const tags = [
    ['desc', tagDesc(description)],
    ['cprt', tagText(copyright)],
    ['wtpt', tagXYZ(whiteXYZ)],                       // v2 convention: media (display) white, absolute
    ['rXYZ', tagXYZ(col(0))],
    ['gXYZ', tagXYZ(col(1))],
    ['bXYZ', tagXYZ(col(2))],
    ['rTRC', tagCurve(trc.r)],
    ['gTRC', tagCurve(trc.g)],
    ['bTRC', tagCurve(trc.b)],
    ['chad', tagSf32(chad)],
    ['vcgt', tagVcgt(vcgt || identity)],
  ];

  const headerSize = 128;
  const tableSize = 4 + tags.length * 12;
  let offset = headerSize + tableSize;
  const placed = [];
  for (const [sig, data] of tags) {
    offset = (offset + 3) & ~3;
    placed.push({ sig, data, offset });
    offset += data.length;
  }
  const total = (offset + 3) & ~3;

  const w = new Writer();
  // ---- header ----
  w.u32(total);
  w.u32(0);                 // preferred CMM
  w.u32(0x02400000);        // version 2.4.0
  w.sig('mntr'); w.sig('RGB '); w.sig('XYZ ');
  const d = date;
  [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()].forEach((v) => w.u16(v));
  w.sig('acsp');
  w.u32(0);                 // primary platform
  w.u32(0);                 // flags
  w.u32(0); w.u32(0);       // manufacturer, model
  w.u32(0); w.u32(0);       // attributes (8 bytes)
  w.u32(0);                 // rendering intent: perceptual
  ICC_D50_XYZ.forEach((v) => w.s15f16(v));
  w.u32(0);                 // creator
  for (let i = 0; i < 16; i++) w.u8(0); // profile ID (v2: zero)
  while (w.length < 128) w.u8(0);
  // ---- tag table ----
  w.u32(tags.length);
  for (const p of placed) { w.sig(p.sig); w.u32(p.offset); w.u32(p.data.length); }
  // ---- tag data ----
  for (const p of placed) {
    while (w.length < p.offset) w.u8(0);
    for (const b of p.data) w.u8(b);
  }
  w.pad4();
  return w.toUint8();
}

// ---------- reader (for tests and for re-importing profiles) ----------
export function parseProfile(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const sig = (o) => String.fromCharCode(buf[o], buf[o + 1], buf[o + 2], buf[o + 3]);
  const s15 = (o) => dv.getInt32(o) / 65536;
  const size = dv.getUint32(0);
  const out = { size, version: dv.getUint32(8), class: sig(12), colorSpace: sig(16), pcs: sig(20), magic: sig(36), tags: {} };
  const n = dv.getUint32(128);
  for (let i = 0; i < n; i++) {
    const base = 132 + i * 12;
    const tsig = sig(base), off = dv.getUint32(base + 4), len = dv.getUint32(base + 8);
    const type = sig(off);
    let value;
    if (type === 'XYZ ') value = [s15(off + 8), s15(off + 12), s15(off + 16)];
    else if (type === 'curv') {
      const cnt = dv.getUint32(off + 8);
      value = []; for (let k = 0; k < cnt; k++) value.push(dv.getUint16(off + 12 + 2 * k) / 65535);
    } else if (type === 'sf32') {
      value = []; for (let k = 0; k < 9; k++) value.push(s15(off + 8 + 4 * k));
    } else if (type === 'vcgt') {
      const gtype = dv.getUint32(off + 8);
      const ch = dv.getUint16(off + 12), cnt = dv.getUint16(off + 14), sz = dv.getUint16(off + 16);
      value = { gtype, channels: ch, count: cnt, size: sz, r: [], g: [], b: [] };
      let p = off + 18;
      for (const c of ['r', 'g', 'b']) for (let k = 0; k < cnt; k++) { value[c].push(dv.getUint16(p) / 65535); p += 2; }
    } else if (type === 'desc') {
      const cnt = dv.getUint32(off + 8);
      value = String.fromCharCode(...buf.slice(off + 12, off + 12 + cnt - 1));
    } else if (type === 'text') {
      value = String.fromCharCode(...buf.slice(off + 8, off + len)).replace(/\0+$/, '');
    }
    out.tags[tsig] = { type, offset: off, length: len, value };
  }
  return out;
}

export { matVec };
