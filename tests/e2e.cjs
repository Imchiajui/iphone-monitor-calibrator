// End-to-end browser test (Playwright + Chromium).
//  1) Simulator mode on the computer page.
//  2) Real protocol: computer page <-> virtual phone page over BroadcastChannel.
// Usage: node tests/e2e.cjs  (serves the repo on a random local port)
const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT = process.env.E2E_OUT || path.join(ROOT, 'tests', 'out');
fs.mkdirSync(OUT, { recursive: true });
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.md': 'text/plain' };

function serve() {
  const server = http.createServer((req, res) => {
    const p = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(p)] || 'application/octet-stream' });
    fs.createReadStream(p).pipe(res);
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

(async () => {
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1, acceptDownloads: true });
  const errors = [];
  let failed = 0;
  const check = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) failed++; };

  // ---------- 1) simulator ----------
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push('display: ' + e.message));
  await page.goto(`${base}/display.html?transport=local&room=simtest`);
  await page.selectOption('#set-mode', 'quick');
  await page.click('#btn-sim');
  await page.click('#btn-start');
  await page.waitForSelector('#step-results:not([hidden])', { timeout: 120000 });
  const tiles = await page.$$eval('#summary .tile .v', (els) => els.map((e) => e.textContent));
  console.log('  simulator summary:', tiles.join(' | '));
  const gammas = tiles[0].split('/').map((s) => parseFloat(s));
  check(gammas.length === 3 && gammas.every((g) => g > 1.8 && g < 2.6), 'simulator: fitted gammas plausible ' + gammas);
  check(Math.abs(gammas[0] - gammas[2]) > 0.15, 'simulator: detects R/B gamma mismatch');
  const [before, after] = tiles[1].split('→').map((s) => parseFloat(s));
  check(after < before && after < 1, `simulator: grey ΔE improves ${before} → ${after}`);
  const charts = await page.$$eval('.chart-host svg path', (els) => els.length);
  check(charts >= 12, 'charts rendered (' + charts + ' paths)');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#dl-cal')]);
  const icc = path.join(OUT, 'e2e_calibrated.icc');
  await dl.saveAs(icc);
  const buf = fs.readFileSync(icc);
  check(buf.readUInt32BE(0) === buf.length && buf.toString('ascii', 36, 40) === 'acsp', 'downloaded ICC header valid (' + buf.length + ' bytes)');
  await page.screenshot({ path: path.join(OUT, 'results.png'), fullPage: true });

  // verification run in simulator
  await page.click('#btn-verify');
  await page.waitForSelector('#verify-result table', { timeout: 120000 });
  const vtxt = await page.textContent('#verify-result .warn');
  console.log('  verification:', vtxt.trim().slice(0, 120));
  check(vtxt.includes('通過'), 'simulator verification passes');

  // ---------- 2) protocol with a virtual phone ----------
  const host = await ctx.newPage();
  host.on('pageerror', (e) => errors.push('host: ' + e.message));
  await host.goto(`${base}/display.html?transport=local&room=proto1`);
  await host.evaluate(() => localStorage.clear());
  await host.reload();
  check(await host.isHidden('#step-results'), 'fresh page shows no stale results');
  const phone = await ctx.newPage();
  phone.on('pageerror', (e) => errors.push('phone: ' + e.message));
  await phone.goto(`${base}/sensor.html#room=proto1&transport=local&virtual=1`);
  await host.waitForFunction(() => !document.querySelector('#btn-start').disabled, null, { timeout: 15000 });
  check(true, 'phone connected over transport; start enabled');
  await host.selectOption('#set-mode', 'quick');
  await host.click('#btn-start');
  await host.waitForTimeout(800);
  await host.keyboard.press('Space'); // skip positioning (virtual phone sends no live preview)
  await host.waitForFunction(() => window.__imcal.raw && window.__imcal.raw.environment && !window.__imcal.raw.environment.simulated, null, { timeout: 300000 });
  await host.waitForSelector('#step-results:not([hidden])', { timeout: 5000 });
  const t2 = await host.$$eval('#summary .tile .v', (els) => els.map((e) => e.textContent));
  console.log('  protocol summary:', t2.join(' | '));
  const g2 = t2[0].split('/').map((s) => parseFloat(s));
  check(g2.every((g) => g > 1.9 && g < 2.6), 'protocol run: gammas plausible ' + g2);
  const phaseText = await phone.textContent('#phase');
  check(/結束/.test(phaseText), 'phone received phase messages: ' + phaseText);
  await phone.screenshot({ path: path.join(OUT, 'phone.png') });

  // ---------- 3) phone layout at iPhone width ----------
  const mob = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  const mp = await mob.newPage();
  await mp.goto(`${base}/sensor.html`);
  const overflow = await mp.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  check(!overflow, 'sensor page has no horizontal scroll at 390px');
  await mp.screenshot({ path: path.join(OUT, 'sensor-mobile.png'), fullPage: true });

  check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join('; ') : ''));
  await browser.close();
  server.close();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
