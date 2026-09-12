// Integration test for admin-managed branding (custom logo upload/reset).
//
// Regression coverage for:
//   - Admin uploads a logo through the real admin-panel UI (file picker +
//     button click) and it's persisted server-side (survives across
//     clients, not just localStorage) and broadcast live to every other
//     connected client without a page refresh.
//   - A non-admin client sees the same branding.
//   - "Reset to Default" removes the uploaded file from disk and reverts
//     every connected client back to the stock /logo.png.

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');

const REPO_ROOT = path.join(__dirname, '..');
const PORT = 34579;
const BASE_URL = `https://localhost:${PORT}`;

// A minimal valid 1x1 red PNG, used as the "logo" an admin uploads.
const TINY_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

function log(msg) { console.log(`[test] ${msg}`); }

function waitForServer(url, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const req = https.get(url, { rejectUnauthorized: false }, (res) => { res.resume(); resolve(); });
      req.on('error', () => {
        if (Date.now() > deadline) reject(new Error('Server did not start in time'));
        else setTimeout(tryOnce, 200);
      });
    };
    tryOnce();
  });
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { rejectUnauthorized: false }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowtoit-logo-test-'));
  const uploadsDir = path.join(tmpDir, 'uploads');
  log(`Working dir: ${tmpDir}`);
  for (const f of ['server.js', 'package.json', 'cert.pem', 'key.pem']) {
    fs.copyFileSync(path.join(REPO_ROOT, f), path.join(tmpDir, f));
  }
  fs.cpSync(path.join(REPO_ROOT, 'public'), path.join(tmpDir, 'public'), { recursive: true });
  fs.symlinkSync(path.join(REPO_ROOT, 'node_modules'), path.join(tmpDir, 'node_modules'));

  const testPngPath = path.join(tmpDir, 'test-logo.png');
  fs.writeFileSync(testPngPath, Buffer.from(TINY_PNG_BASE64, 'base64'));

  const serverProc = spawn('node', ['server.js'], {
    cwd: tmpDir,
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'ignore',
  });

  let browser;
  const failures = [];
  try {
    await waitForServer(`${BASE_URL}/api/admin-exists`);
    log('Server is up');

    const before = await getJson(`${BASE_URL}/api/branding`);
    if (before.logoUrl !== '/logo.png') failures.push(`Expected default logoUrl '/logo.png', got '${before.logoUrl}'`);

    browser = await chromium.launch();
    const ctxA = await browser.newContext({ ignoreHTTPSErrors: true }); // admin
    const ctxB = await browser.newContext({ ignoreHTTPSErrors: true }); // regular user
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();

    await pageA.goto(BASE_URL);
    await pageA.waitForSelector('#step-admin-setup.active', { timeout: 10000 });
    await pageA.fill('#setup-admin-name', 'Alice');
    await pageA.fill('#setup-admin-code', 'testcode123');
    await pageA.click('#btn-setup-admin');
    await pageA.waitForSelector('#step-channels.active', { timeout: 15000 });
    log('Alice: admin created and logged in');

    await pageB.goto(BASE_URL);
    await pageB.waitForSelector('#step-login.active', { timeout: 10000 });
    await pageB.fill('#input-username', 'Bob');
    await pageB.click('#btn-login');
    await pageB.waitForSelector('#step-channels.active', { timeout: 15000 });
    log('Bob: logged in');

    // Join the default channel to dismiss the setup overlay (the admin panel
    // button lives behind it).
    await pageA.click('.ch-item[data-channel="general"]');
    await pageB.click('.ch-item[data-channel="general"]');
    await pageA.waitForSelector('#setup-overlay', { state: 'hidden', timeout: 10000 });
    await pageB.waitForSelector('#setup-overlay', { state: 'hidden', timeout: 10000 });

    // Both should have the header logo pointing at the stock file initially.
    const headerSrcBefore = await pageB.$eval('#app-logo-header', (el) => el.getAttribute('src'));
    if (headerSrcBefore !== '/logo.png') failures.push(`Bob: expected header logo '/logo.png' before upload, got '${headerSrcBefore}'`);

    // --- Alice opens the admin panel and uploads a custom logo through the real UI ---
    await pageA.click('#btn-admin');
    await pageA.waitForSelector('#admin-panel.show', { timeout: 5000 });
    await pageA.setInputFiles('#admin-logo-file', testPngPath);
    await pageA.click('#btn-admin-upload-logo');
    log('Alice: uploaded a custom logo via the admin panel');

    await pageA.waitForFunction(() => {
      const el = document.querySelector('#app-logo-header');
      return el && el.getAttribute('src').includes('/uploads/logo-');
    }, null, { timeout: 10000 });
    const aliceHeaderSrc = await pageA.$eval('#app-logo-header', (el) => el.getAttribute('src'));
    log(`Alice: header logo is now ${aliceHeaderSrc}`);

    // --- Bob, who did nothing, should see the new logo live via broadcast ---
    await pageB.waitForFunction(() => {
      const el = document.querySelector('#app-logo-header');
      return el && el.getAttribute('src').includes('/uploads/logo-');
    }, null, { timeout: 10000 });
    const bobHeaderSrc = await pageB.$eval('#app-logo-header', (el) => el.getAttribute('src'));
    log(`Bob: header logo live-updated to ${bobHeaderSrc}`);
    if (bobHeaderSrc !== aliceHeaderSrc) failures.push(`Bob's logo URL (${bobHeaderSrc}) doesn't match Alice's (${aliceHeaderSrc}) — broadcast not reaching other clients`);

    // The uploaded file must actually be servable (not a broken image)
    const uploadedUrl = `${BASE_URL}${aliceHeaderSrc}`;
    const fetched = await pageA.evaluate(async (url) => {
      const r = await fetch(url);
      return { ok: r.ok, status: r.status, type: r.headers.get('content-type') };
    }, uploadedUrl);
    if (!fetched.ok || !fetched.type?.startsWith('image/')) {
      failures.push(`Uploaded logo not servable: ${JSON.stringify(fetched)}`);
    }

    // The server's branding API and disk should agree
    const afterUpload = await getJson(`${BASE_URL}/api/branding`);
    if (afterUpload.logoUrl !== aliceHeaderSrc) failures.push(`/api/branding (${afterUpload.logoUrl}) doesn't match what the page applied (${aliceHeaderSrc})`);
    const filesOnDisk = fs.existsSync(uploadsDir) ? fs.readdirSync(uploadsDir) : [];
    if (filesOnDisk.length !== 1) failures.push(`Expected exactly 1 file in uploads/, found ${filesOnDisk.length}: ${JSON.stringify(filesOnDisk)}`);

    // --- Reset to default ---
    await pageA.click('#btn-admin-reset-logo');
    await pageA.waitForFunction(() => document.querySelector('#app-logo-header').getAttribute('src') === '/logo.png', null, { timeout: 10000 });
    await pageB.waitForFunction(() => document.querySelector('#app-logo-header').getAttribute('src') === '/logo.png', null, { timeout: 10000 });
    log('Both peers reverted to the default logo');

    const afterReset = await getJson(`${BASE_URL}/api/branding`);
    if (afterReset.logoUrl !== '/logo.png') failures.push(`Expected logoUrl back to '/logo.png' after reset, got '${afterReset.logoUrl}'`);
    const filesAfterReset = fs.existsSync(uploadsDir) ? fs.readdirSync(uploadsDir) : [];
    if (filesAfterReset.length !== 0) failures.push(`Expected uploads/ to be empty after reset, found: ${JSON.stringify(filesAfterReset)}`);

    await ctxA.close();
    await ctxB.close();
  } finally {
    if (browser) await browser.close();
    serverProc.kill();
    await new Promise((r) => setTimeout(r, 300));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  if (failures.length) {
    console.error('\n[test] FAILED:');
    for (const f of failures) console.error('  - ' + f);
    process.exit(1);
  }
  console.log('\n[test] PASSED: admin logo upload persists, broadcasts live, and resets cleanly.');
}

main().catch((err) => {
  console.error('[test] FATAL:', err);
  process.exit(1);
});
