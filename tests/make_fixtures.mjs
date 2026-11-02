// Writes fixtures for the Python cross-validation (tests/validate.py).
import { writeFileSync, mkdirSync } from 'node:fs';
import { VirtualDisplay, VirtualCamera, simulatedSensor, rng } from '../js/core/simulator.js';
import { runCharacterisation } from '../js/core/session.js';
import { analyse, buildProfiles } from '../js/core/analysis.js';
import { deltaE2000 } from '../js/core/colorimetry.js';

const out = process.argv[2] || 'tests/out';
mkdirSync(out, { recursive: true });
const display = new VirtualDisplay();
const sensor = simulatedSensor({ display, camera: new VirtualCamera({ seed: 5 }) });
const raw = await runCharacterisation({ measure: sensor, mode: 'quick' });
for (const prim of ['srgb', 'p3']) {
  const A = analyse(raw, { target: 'gamma22', primaries: prim });
  const { calibrated, profileOnly } = buildProfiles(A, { date: new Date('2026-01-02T03:04:05Z') });
  writeFileSync(`${out}/calibrated_${prim}.icc`, calibrated);
  writeFileSync(`${out}/profileonly_${prim}.icc`, profileOnly);
  if (prim === 'srgb') writeFileSync(`${out}/lut.json`, JSON.stringify({ r: [...A.lut.r], g: [...A.lut.g], b: [...A.lut.b] }));
}
const r = rng(42), pairs = [];
for (let i = 0; i < 500; i++) {
  const a = [r() * 100, r() * 200 - 100, r() * 200 - 100], b = [r() * 100, r() * 200 - 100, r() * 200 - 100];
  if (i % 3 === 0) for (let k = 0; k < 3; k++) b[k] = a[k] + (r() - 0.5) * 6;
  pairs.push({ a, b, de: deltaE2000(a, b) });
}
writeFileSync(`${out}/de_pairs.json`, JSON.stringify(pairs));
console.log('fixtures written to', out);
