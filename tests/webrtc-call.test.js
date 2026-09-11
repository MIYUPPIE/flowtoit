// Integration test: two real browser peers place a 1:1 call over the real
// signaling server and must end up with exactly one working WebRTC
// connection each, carrying live audio + video, with no duplicate audio
// output path.
//
// This is a regression test for three bugs fixed together:
//   1. Glare: both caller and callee used to call createConnection(peerId,
//      true), so both sent competing SDP offers and the call would
//      frequently fail to negotiate. Now only the caller initiates.
//   2. Double audio: remote audio used to be played both through a
//      persistent <audio> element AND through a parallel Web Audio API
//      graph routed to the speakers, causing an echo. The Web Audio route
//      was redundant (a separate silent-oscillator keep-alive already
//      exists) and has been removed.
//   3. ICE candidates arriving before the remote description was set used
//      to be silently dropped. They are now queued and flushed once the
//      remote description is applied.
//
// This is a slow integration test (spawns a real HTTPS server + two
// headless Chromium instances with fake camera/mic devices) — run it with
// `npm run test:webrtc`, not as part of the fast pre-commit gate.

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');

const REPO_ROOT = path.join(__dirname, '..');
const PORT = 34567;
const BASE_URL = `https://localhost:${PORT}`;

function log(msg) { console.log(`[test] ${msg}`); }

function waitForServer(url, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const req = https.get(url, { rejectUnauthorized: false }, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', () => {
        if (Date.now() > deadline) reject(new Error('Server did not start in time'));
        else setTimeout(tryOnce, 200);
      });
    };
    tryOnce();
  });
}

async function main() {
  // Isolated copy of the app so this test never touches the developer's
  // real data.json (real usernames/admin creds) or the server they might
  // already have running on port 3000.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowtoit-test-'));
  log(`Working dir: ${tmpDir}`);
  for (const f of ['server.js', 'package.json', 'cert.pem', 'key.pem']) {
    fs.copyFileSync(path.join(REPO_ROOT, f), path.join(tmpDir, f));
  }
  fs.cpSync(path.join(REPO_ROOT, 'public'), path.join(tmpDir, 'public'), { recursive: true });
  fs.symlinkSync(path.join(REPO_ROOT, 'node_modules'), path.join(tmpDir, 'node_modules'));

  const serverProc = spawn('node', ['server.js'], {
    cwd: tmpDir,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverOutput = '';
  serverProc.stdout.on('data', (d) => { serverOutput += d; });
  serverProc.stderr.on('data', (d) => { serverOutput += d; });

  let browser;
  const failures = [];
  try {
    await waitForServer(`${BASE_URL}/api/admin-exists`);
    log('Server is up');

    browser = await chromium.launch({
      args: [
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
      ],
    });

    const makeContext = async () => {
      const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
      await ctx.grantPermissions(['camera', 'microphone'], { origin: BASE_URL });
      // Spy on createMediaStreamSource before any page script runs, so we can
      // prove nothing routes a remote peer's audio through Web Audio (the
      // double-playback bug).
      await ctx.addInitScript(() => {
        // The local mic level meter legitimately calls
        // createMediaStreamSource(STATE.localStream) — that's fine. What must
        // NOT happen is a *remote* peer's stream being routed through Web
        // Audio to the speakers (that was the echo bug: the persistent
        // <audio> element already plays it once).
        window.__mssStreams = [];
        const orig = AudioContext.prototype.createMediaStreamSource;
        AudioContext.prototype.createMediaStreamSource = function (stream, ...rest) {
          window.__mssStreams.push(stream);
          return orig.call(this, stream, ...rest);
        };
        window.__consoleErrors = [];
        const origError = console.error;
        console.error = (...args) => { window.__consoleErrors.push(args.map(String).join(' ')); origError(...args); };
      });
      return ctx;
    };

    const ctxA = await makeContext();
    const ctxB = await makeContext();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();

    // --- Peer A: first-time admin setup ---
    await pageA.goto(BASE_URL);
    await pageA.waitForSelector('#step-admin-setup.active', { timeout: 10000 });
    await pageA.fill('#setup-admin-name', 'Alice');
    await pageA.fill('#setup-admin-code', 'testcode123');
    await pageA.click('#btn-setup-admin');
    await pageA.waitForSelector('#step-channels.active', { timeout: 15000 });
    log('Alice: admin created and logged in');

    // --- Peer B: regular login (admin now exists, so no auto-login PIN yet) ---
    await pageB.goto(BASE_URL);
    await pageB.waitForSelector('#step-login.active', { timeout: 10000 });
    await pageB.fill('#input-username', 'Bob');
    await pageB.click('#btn-login');
    await pageB.waitForSelector('#step-channels.active', { timeout: 15000 });
    log('Bob: logged in');

    // --- Both join the default "general" channel ---
    await pageA.click('.ch-item[data-channel="general"]');
    await pageB.click('.ch-item[data-channel="general"]');
    await pageA.waitForFunction(() => STATE && STATE.channel === 'general', null, { timeout: 10000 });
    await pageB.waitForFunction(() => STATE && STATE.channel === 'general', null, { timeout: 10000 });
    log('Both peers joined #general');

    // Peers need a moment to see each other in the live peer list
    await pageA.waitForFunction(() => STATE.peers.length > 0, null, { timeout: 10000 });
    await pageB.waitForFunction(() => STATE.peers.length > 0, null, { timeout: 10000 });

    // --- Alice calls Bob (1:1 "individual" call — the buggy path) ---
    await pageA.click('#peer-list .peer-item');
    log('Alice called Bob, waiting for incoming-call UI on Bob\'s side...');
    await pageB.waitForSelector('#incoming-overlay.show', { timeout: 10000 });
    // force:true — the incoming-call UI has a pulsing CSS animation, which
    // keeps Playwright's actionability check ("element is not stable") from
    // ever being satisfied.
    await pageB.click('#btn-accept', { force: true });
    log('Bob accepted the call');

    // --- Wait for both sides to establish exactly one working connection ---
    const waitConnected = (page, who) => page.waitForFunction(() => {
      const conns = Object.values(STATE.connections);
      if (conns.length !== 1) return false;
      const state = conns[0].pc.iceConnectionState;
      return state === 'connected' || state === 'completed';
    }, null, { timeout: 20000 }).catch((e) => {
      throw new Error(`${who} never reached a single connected peer connection: ${e.message}`);
    });
    await Promise.all([waitConnected(pageA, 'Alice'), waitConnected(pageB, 'Bob')]);
    log('Both sides report exactly one connected RTCPeerConnection');

    // --- Assert live audio + video tracks actually arrived on both sides ---
    const checkMedia = async (page, who) => {
      const info = await page.evaluate(() => {
        const conn = Object.values(STATE.connections)[0];
        return {
          connectionCount: Object.keys(STATE.connections).length,
          audioTracks: conn.remoteStream.getAudioTracks().filter(t => t.readyState === 'live').length,
          videoTracks: conn.remoteStream.getVideoTracks().filter(t => t.readyState === 'live').length,
          iceState: conn.pc.iceConnectionState,
          signalingState: conn.pc.signalingState,
          remoteStreamRoutedThroughWebAudio: window.__mssStreams.includes(conn.remoteStream),
          persistentAudioEls: document.querySelectorAll('audio[id^="persistent-audio-"]').length,
          consoleErrors: window.__consoleErrors,
          hasRouteThroughWebAudio: typeof window.routeThroughWebAudio,
        };
      });
      log(`${who}: ${JSON.stringify(info)}`);

      if (info.connectionCount !== 1) failures.push(`${who}: expected exactly 1 connection, got ${info.connectionCount} (glare bug regression)`);
      if (info.audioTracks !== 1) failures.push(`${who}: expected 1 live remote audio track, got ${info.audioTracks}`);
      if (info.videoTracks !== 1) failures.push(`${who}: expected 1 live remote video track, got ${info.videoTracks}`);
      if (info.signalingState !== 'stable') failures.push(`${who}: signalingState is '${info.signalingState}', expected 'stable' (indicates a broken offer/answer exchange)`);
      if (info.remoteStreamRoutedThroughWebAudio) failures.push(`${who}: the remote peer's stream was routed through createMediaStreamSource — remote audio is being double-played (once via <audio>, once via Web Audio) again (echo bug regression)`);
      if (info.persistentAudioEls !== 1) failures.push(`${who}: expected exactly 1 persistent <audio> element for the remote peer, found ${info.persistentAudioEls}`);
      if (info.hasRouteThroughWebAudio !== 'undefined') failures.push(`${who}: routeThroughWebAudio() still exists on the page — dead code / bug regression not actually removed`);
      const badErrors = info.consoleErrors.filter(e => /setRemoteDescription|wrong state|InvalidStateError/i.test(e));
      if (badErrors.length) failures.push(`${who}: signaling state errors in console (glare regression): ${JSON.stringify(badErrors)}`);
    };
    await checkMedia(pageA, 'Alice');
    await checkMedia(pageB, 'Bob');

    // --- Video grid diffing: verify unrelated boxes aren't torn down on every track event ---
    const gridStable = await pageA.evaluate(async () => {
      const box = document.querySelector('#video-grid [data-grid-id="local"]');
      if (!box) return { ok: false, reason: 'no local video box found' };
      const videoEl = box.querySelector('video');
      const before = videoEl || null;
      window.updateVideoGrid(); // simulate an unrelated re-render (e.g. another track event)
      const after = document.querySelector('#video-grid [data-grid-id="local"] video');
      return { ok: before !== null && before === after, hadBefore: !!before, hadAfter: !!after };
    });
    log(`Alice: video grid stability check: ${JSON.stringify(gridStable)}`);
    if (!gridStable.ok) failures.push(`Alice: local <video> element was recreated by a redundant updateVideoGrid() call (flicker bug regression): ${JSON.stringify(gridStable)}`);

    await ctxA.close();
    await ctxB.close();
  } finally {
    if (browser) await browser.close();
    serverProc.kill();
    await new Promise((r) => setTimeout(r, 300));
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (failures.length) {
      console.error('\n[test] Server output (for debugging):\n' + serverOutput);
    }
  }

  if (failures.length) {
    console.error('\n[test] FAILED:');
    for (const f of failures) console.error('  - ' + f);
    process.exit(1);
  }
  console.log('\n[test] PASSED: 1:1 call establishes one clean connection with live audio+video, no echo, no flicker.');
}

main().catch((err) => {
  console.error('[test] FATAL:', err);
  process.exit(1);
});
