const express = require('express');
const http = require('http');
const https = require('https');
const fs = require('fs');
const WebSocket = require('ws');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execSync } = require('child_process');

const app = express();
app.use(express.json());

// ── Get LAN IPs ─────────────────────────────────────────────────────────────
function getLanIPs() {
  const nets = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) ips.push({ name, address: net.address });
    }
  }
  return ips;
}

// ── Auto-generate self-signed cert if missing ──────────────────────────────
function ensureCerts(certPath, keyPath) {
  if (fs.existsSync(certPath) && fs.existsSync(keyPath)) return true;
  try {
    const ips = getLanIPs();
    const sanEntries = ['DNS:localhost', 'IP:127.0.0.1', ...ips.map(i => `IP:${i.address}`)];
    const san = sanEntries.join(',');
    execSync(
      `openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 ` +
      `-keyout "${keyPath}" -out "${certPath}" -days 3650 -nodes ` +
      `-subj "/CN=FlowToIt" -addext "subjectAltName=${san}" 2>/dev/null`,
      { timeout: 10000 }
    );
    console.log('  ✅ Self-signed SSL cert generated');
    return true;
  } catch {
    try {
      execSync(
        `openssl req -x509 -newkey rsa:2048 ` +
        `-keyout "${keyPath}" -out "${certPath}" -days 3650 -nodes ` +
        `-subj "/CN=FlowToIt" 2>/dev/null`,
        { timeout: 10000 }
      );
      console.log('  ✅ Self-signed SSL cert generated');
      return true;
    } catch {
      console.warn('  ⚠  Could not generate SSL certs. Install openssl.');
      return false;
    }
  }
}

// ── HTTPS ───────────────────────────────────────────────────────────────────
let server;
const certPath = path.join(__dirname, 'cert.pem');
const keyPath = path.join(__dirname, 'key.pem');
const hasCerts = ensureCerts(certPath, keyPath);
if (hasCerts) {
  server = https.createServer({ key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) }, app);
} else {
  console.warn('  ⚠  Running HTTP only. WebRTC features may be limited.');
  server = http.createServer(app);
}
const wss = new WebSocket.Server({ server });

if (server instanceof https.Server) {
  const redir = http.createServer((req, res) => {
    const host = req.headers.host?.replace(/:.*/, '') || 'localhost';
    res.writeHead(301, { Location: `https://${host}:${process.env.PORT || 3000}${req.url}` });
    res.end();
  });
  redir.listen(3080, '0.0.0.0', () => {}).on('error', () => {
    // Port 3080 busy — skip redirect server (common in Termux)
  });
}

app.use(express.static(path.join(__dirname, 'public')));

// ── Persistent Data Store ───────────────────────────────────────────────────
const DATA_FILE = path.join(__dirname, 'data.json');

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) { console.error('Error loading data:', e.message); }
  return { adminCode: null, users: {}, categories: {}, channels: {} };
}
function saveData() {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(DB, null, 2)); } catch (e) { console.error('Save error:', e); }
}
let DB = loadData();

// Ensure defaults
if (!DB.categories['default']) {
  DB.categories['default'] = { name: 'General', createdBy: 'system', createdAt: Date.now() };
}
if (!DB.channels['general']) {
  DB.channels['general'] = { code: null, categoryId: 'default', createdBy: 'system', createdAt: Date.now(), description: 'Default channel' };
}
if (!DB.chatHistory) DB.chatHistory = {};
saveData();

const CHAT_HISTORY_LIMIT = 200;
const WS_HEARTBEAT_INTERVAL_MS = 25000;

function hashCode(code) { return crypto.createHash('sha256').update(String(code)).digest('hex'); }

// ── Runtime State ───────────────────────────────────────────────────────────
const clients = new Map();       // peerId → { ws, username, channel, isAdmin }
const liveChannels = new Map();  // channelName → Set<peerId>

function broadcast(ch, msg, excludeId) {
  const members = liveChannels.get(ch);
  if (!members) return;
  const raw = JSON.stringify(msg);
  for (const pid of members) {
    if (pid === excludeId) continue;
    const c = clients.get(pid);
    if (c && c.ws.readyState === WebSocket.OPEN) c.ws.send(raw);
  }
}
function sendTo(pid, msg) {
  const c = clients.get(pid);
  if (c && c.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify(msg));
}
function sendWs(ws, msg) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}
function broadcastAll(msg) {
  const raw = JSON.stringify(msg);
  for (const [, c] of clients) if (c.ws.readyState === WebSocket.OPEN) c.ws.send(raw);
}
function peerList(ch) {
  const m = liveChannels.get(ch);
  if (!m) return [];
  return [...m].map(pid => { const c = clients.get(pid); return c ? { peerId: pid, username: c.username, isAdmin: c.isAdmin } : null; }).filter(Boolean);
}
function removeFromChannel(peerId) {
  const c = clients.get(peerId);
  if (!c) return;
  const ch = c.channel;
  if (ch && liveChannels.has(ch)) {
    liveChannels.get(ch).delete(peerId);
    if (liveChannels.get(ch).size === 0) liveChannels.delete(ch);
    else broadcast(ch, { type: 'peer-left', peerId, username: c.username, peers: peerList(ch) }, peerId);
  }
}
function getChannelList() {
  return Object.entries(DB.channels).map(([name, ch]) => ({
    name, hasCode: !!ch.code, categoryId: ch.categoryId || 'default',
    description: ch.description || '',
    online: liveChannels.has(name) ? liveChannels.get(name).size : 0,
  }));
}

// ── REST API ────────────────────────────────────────────────────────────────
app.get('/api/admin-exists', (req, res) => res.json({ exists: !!DB.adminCode }));

app.post('/api/setup-admin', (req, res) => {
  if (DB.adminCode) return res.status(400).json({ error: 'Admin already set up' });
  const { code, username } = req.body;
  if (!code || code.length < 4) return res.status(400).json({ error: 'Admin code must be ≥ 4 chars' });
  if (!username?.trim()) return res.status(400).json({ error: 'Username required' });
  DB.adminCode = hashCode(code);
  DB.users[username.trim()] = { createdAt: Date.now(), lastSeen: Date.now(), isAdmin: true };
  saveData();
  res.json({ success: true });
});

app.get('/api/users', (req, res) => {
  res.json(Object.entries(DB.users).map(([name, u]) => ({ username: name, isAdmin: u.isAdmin || false, lastSeen: u.lastSeen })));
});

// Lightweight list for autocomplete (just usernames)
app.get('/api/usernames', (req, res) => {
  res.json(Object.keys(DB.users));
});

app.get('/api/channels', (req, res) => res.json(getChannelList()));
app.get('/api/categories', (req, res) => {
  res.json(Object.entries(DB.categories).map(([id, c]) => ({ id, name: c.name })));
});

// ── WebSocket ───────────────────────────────────────────────────────────────
wss.on('connection', (ws) => {
  let peerId = null;
  ws.isAlive = true;

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {

      case 'login': {
        const username = (msg.username || '').trim();
        if (!username) { sendWs(ws, { type: 'login-error', error: 'Username required' }); break; }
        const adminCode = msg.adminCode || null;
        const devicePin = msg.devicePin || null;
        let isAdmin = false;

        // Check admin code validity
        const validAdminCode = adminCode && DB.adminCode && hashCode(adminCode) === DB.adminCode;
        if (validAdminCode) {
          // Only one admin allowed — check if someone else is already admin
          const existingAdmin = Object.entries(DB.users).find(([n, u]) => u.isAdmin && n !== username);
          if (existingAdmin) {
            sendWs(ws, { type: 'login-error', error: `Admin already exists (${existingAdmin[0]}). Only one admin allowed.` });
            break;
          }
          isAdmin = true;
        }

        if (!DB.users[username]) {
          DB.users[username] = { createdAt: Date.now(), lastSeen: Date.now(), isAdmin, devicePin: devicePin || null };
        } else {
          DB.users[username].lastSeen = Date.now();
          if (DB.users[username].isAdmin) isAdmin = true;
          if (validAdminCode) { DB.users[username].isAdmin = true; isAdmin = true; }
          // Update device pin if provided
          if (devicePin) DB.users[username].devicePin = devicePin;
        }
        saveData();
        peerId = msg.peerId;
        clients.set(peerId, { ws, username, channel: null, isAdmin });

        sendWs(ws, {
          type: 'login-success', username, isAdmin,
          categories: Object.entries(DB.categories).map(([id, c]) => ({ id, name: c.name })),
          channels: getChannelList(),
        });
        break;
      }

      // Auto-login via device PIN
      case 'pin-login': {
        const devicePin = (msg.devicePin || '').trim();
        if (!devicePin) { sendWs(ws, { type: 'login-error', error: 'No device PIN' }); break; }
        // Find user by device pin
        const found = Object.entries(DB.users).find(([, u]) => u.devicePin === devicePin);
        if (!found) { sendWs(ws, { type: 'pin-login-fail' }); break; }
        const [foundName, foundUser] = found;
        foundUser.lastSeen = Date.now();
        saveData();
        peerId = msg.peerId;
        const foundIsAdmin = !!foundUser.isAdmin;
        clients.set(peerId, { ws, username: foundName, channel: null, isAdmin: foundIsAdmin });
        sendWs(ws, {
          type: 'login-success', username: foundName, isAdmin: foundIsAdmin,
          categories: Object.entries(DB.categories).map(([id, c]) => ({ id, name: c.name })),
          channels: getChannelList(),
        });
        break;
      }

      case 'join': {
        if (!peerId) break;
        const channel = (msg.channel || 'general').trim();
        const c = clients.get(peerId);
        if (!c) break;
        const chData = DB.channels[channel];
        if (chData && chData.code) {
          if (!msg.channelCode || hashCode(msg.channelCode) !== chData.code) {
            sendTo(peerId, { type: 'join-error', error: 'Invalid channel code', channel });
            break;
          }
        }
        removeFromChannel(peerId);
        c.channel = channel;
        if (!liveChannels.has(channel)) liveChannels.set(channel, new Set());
        liveChannels.get(channel).add(peerId);
        broadcast(channel, { type: 'peer-joined', peerId, username: c.username, peers: peerList(channel) }, peerId);
        sendTo(peerId, { type: 'channel-info', channel, peers: peerList(channel) });
        // Send chat history for this channel
        const history = DB.chatHistory[channel] || [];
        if (history.length > 0) {
          sendTo(peerId, { type: 'chat-history', channel, messages: history });
        }
        break;
      }

      case 'leave-channel': {
        if (!peerId) break;
        removeFromChannel(peerId);
        const c = clients.get(peerId);
        if (c) c.channel = null;
        sendTo(peerId, { type: 'left-channel' });
        break;
      }

      case 'logout': {
        if (!peerId) break;
        removeFromChannel(peerId);
        clients.delete(peerId);
        sendWs(ws, { type: 'logged-out' });
        peerId = null;
        break;
      }

      case 'set-pin': {
        if (!peerId) break;
        const c = clients.get(peerId);
        if (!c) break;
        const newPin = (msg.pin || '').trim();
        if (!newPin || newPin.length < 4) {
          sendWs(ws, { type: 'set-pin-error', error: 'PIN must be at least 4 characters' });
          break;
        }
        // Check if this PIN is already used by another user
        const pinOwner = Object.entries(DB.users).find(([name, u]) => u.devicePin === newPin && name !== c.username);
        if (pinOwner) {
          sendWs(ws, { type: 'set-pin-error', error: 'This PIN is already in use by another user' });
          break;
        }
        DB.users[c.username].devicePin = newPin;
        saveData();
        sendWs(ws, { type: 'set-pin-success', pin: newPin });
        break;
      }

      case 'ping': {
        sendWs(ws, { type: 'pong', ts: msg.ts });
        break;
      }

      case 'list-channels': {
        sendWs(ws, { type: 'channels-updated', channels: getChannelList() });
        break;
      }

      // ── Admin actions ───────────────────────────────────────────────
      case 'admin-create-category': {
        const c = clients.get(peerId);
        if (!c?.isAdmin) { sendTo(peerId, { type: 'admin-error', error: 'Not authorized' }); break; }
        const catName = (msg.name || '').trim();
        if (!catName) { sendTo(peerId, { type: 'admin-error', error: 'Name required' }); break; }
        const catId = catName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/,'');
        if (DB.categories[catId]) { sendTo(peerId, { type: 'admin-error', error: 'Already exists' }); break; }
        DB.categories[catId] = { name: catName, createdBy: c.username, createdAt: Date.now() };
        saveData();
        broadcastAll({ type: 'categories-updated', categories: Object.entries(DB.categories).map(([id,ct]) => ({ id, name: ct.name })) });
        sendTo(peerId, { type: 'admin-success', message: `Category "${catName}" created` });
        break;
      }

      case 'admin-delete-category': {
        const c = clients.get(peerId);
        if (!c?.isAdmin) { sendTo(peerId, { type: 'admin-error', error: 'Not authorized' }); break; }
        if (msg.categoryId === 'default') { sendTo(peerId, { type: 'admin-error', error: 'Cannot delete default' }); break; }
        if (!DB.categories[msg.categoryId]) { sendTo(peerId, { type: 'admin-error', error: 'Not found' }); break; }
        for (const ch of Object.values(DB.channels)) { if (ch.categoryId === msg.categoryId) ch.categoryId = 'default'; }
        delete DB.categories[msg.categoryId];
        saveData();
        broadcastAll({ type: 'categories-updated', categories: Object.entries(DB.categories).map(([id,ct]) => ({ id, name: ct.name })) });
        broadcastAll({ type: 'channels-updated', channels: getChannelList() });
        sendTo(peerId, { type: 'admin-success', message: 'Category deleted' });
        break;
      }

      case 'admin-create-channel': {
        const c = clients.get(peerId);
        if (!c?.isAdmin) { sendTo(peerId, { type: 'admin-error', error: 'Not authorized' }); break; }
        const chName = (msg.name || '').trim().toLowerCase().replace(/[^a-z0-9-_]+/g, '-').replace(/-+$/,'');
        if (!chName) { sendTo(peerId, { type: 'admin-error', error: 'Name required' }); break; }
        if (DB.channels[chName]) { sendTo(peerId, { type: 'admin-error', error: 'Already exists' }); break; }
        DB.channels[chName] = { code: msg.code ? hashCode(msg.code) : null, categoryId: msg.categoryId || 'default', createdBy: c.username, createdAt: Date.now(), description: msg.description || '' };
        saveData();
        broadcastAll({ type: 'channels-updated', channels: getChannelList() });
        sendTo(peerId, { type: 'admin-success', message: `Channel "${chName}" created` });
        break;
      }

      case 'admin-delete-channel': {
        const c = clients.get(peerId);
        if (!c?.isAdmin) { sendTo(peerId, { type: 'admin-error', error: 'Not authorized' }); break; }
        if (msg.name === 'general') { sendTo(peerId, { type: 'admin-error', error: 'Cannot delete general' }); break; }
        if (!DB.channels[msg.name]) { sendTo(peerId, { type: 'admin-error', error: 'Not found' }); break; }
        if (liveChannels.has(msg.name)) {
          broadcast(msg.name, { type: 'channel-deleted', channel: msg.name });
          for (const pid of liveChannels.get(msg.name)) { const pc = clients.get(pid); if (pc) pc.channel = null; }
          liveChannels.delete(msg.name);
        }
        delete DB.channels[msg.name];
        saveData();
        broadcastAll({ type: 'channels-updated', channels: getChannelList() });
        sendTo(peerId, { type: 'admin-success', message: `Channel "${msg.name}" deleted` });
        break;
      }

      case 'admin-set-channel-code': {
        const c = clients.get(peerId);
        if (!c?.isAdmin) { sendTo(peerId, { type: 'admin-error', error: 'Not authorized' }); break; }
        if (!DB.channels[msg.channel]) { sendTo(peerId, { type: 'admin-error', error: 'Not found' }); break; }
        DB.channels[msg.channel].code = msg.code ? hashCode(msg.code) : null;
        saveData();
        broadcastAll({ type: 'channels-updated', channels: getChannelList() });
        sendTo(peerId, { type: 'admin-success', message: msg.code ? `Code set for "${msg.channel}"` : `Code removed from "${msg.channel}"` });
        break;
      }

      case 'admin-reset': {
        const c = clients.get(peerId);
        if (!c?.isAdmin) { sendTo(peerId, { type: 'admin-error', error: 'Not authorized' }); break; }
        // Notify all connected clients before reset
        broadcastAll({ type: 'server-reset' });
        // Disconnect all clients
        for (const [pid, cl] of clients) {
          removeFromChannel(pid);
          if (cl.ws.readyState === WebSocket.OPEN) cl.ws.close();
        }
        clients.clear();
        liveChannels.clear();
        // Reset database to factory defaults
        DB = {
          adminCode: null,
          users: {},
          categories: { 'default': { name: 'General', createdBy: 'system', createdAt: Date.now() } },
          channels: { 'general': { code: null, categoryId: 'default', createdBy: 'system', createdAt: Date.now(), description: 'Default channel' } },
          chatHistory: {}
        };
        saveData();
        console.log('  \u26A0  Server reset by admin:', c.username);
        break;
      }

      // ── WebRTC / call signaling ─────────────────────────────────────
      case 'offer': case 'answer': case 'ice-candidate':
        sendTo(msg.target, { ...msg, from: peerId }); break;
      case 'broadcast-call': {
        const c = clients.get(peerId);
        if (c) broadcast(c.channel, { type: 'broadcast-call', from: peerId, username: c.username }, peerId);
        break;
      }
      case 'call-peer': {
        const c = clients.get(peerId);
        if (c) sendTo(msg.target, { type: 'call-peer', from: peerId, username: c.username });
        break;
      }
      case 'call-accept': case 'call-reject':
        sendTo(msg.target, { ...msg, from: peerId }); break;

      // ── Chat / files ────────────────────────────────────────────────
      case 'chat': {
        const c = clients.get(peerId);
        if (!c) break;
        const chatMsg = { type: 'chat', from: peerId, username: c.username, text: msg.text, timestamp: Date.now() };
        if (msg.target) {
          sendTo(msg.target, chatMsg);
        } else {
          // Store in persistent chat history (channel messages only)
          const ch = c.channel;
          if (ch) {
            if (!DB.chatHistory[ch]) DB.chatHistory[ch] = [];
            DB.chatHistory[ch].push({ username: c.username, text: msg.text, timestamp: chatMsg.timestamp });
            if (DB.chatHistory[ch].length > CHAT_HISTORY_LIMIT) {
              DB.chatHistory[ch] = DB.chatHistory[ch].slice(-CHAT_HISTORY_LIMIT);
            }
            saveData();
          }
          broadcast(ch, chatMsg, peerId);
        }
        break;
      }
      case 'file-offer': {
        const c = clients.get(peerId);
        if (!c) break;
        if (msg.target) sendTo(msg.target, { ...msg, from: peerId, username: c.username });
        else broadcast(c.channel, { ...msg, from: peerId, username: c.username }, peerId);
        break;
      }
      case 'file-accept': case 'file-reject':
        sendTo(msg.target, { ...msg, from: peerId }); break;
    }
  });

  ws.on('close', () => {
    if (peerId) { removeFromChannel(peerId); clients.delete(peerId); }
  });
});

setInterval(() => {
  for (const client of wss.clients) {
    if (client.readyState !== WebSocket.OPEN) continue;
    if (!client.isAlive) {
      client.terminate();
      continue;
    }
    client.isAlive = false;
    try { client.ping(); } catch {}
  }
}, WS_HEARTBEAT_INTERVAL_MS);

// ── Start ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const proto = server instanceof https.Server ? 'https' : 'http';

// ── Server Info API (for network display) ───────────────────────────────────
app.get('/api/server-info', (req, res) => {
  const ips = getLanIPs();
  res.json({
    name: 'FlowToIt',
    proto,
    port: PORT,
    local: `${proto}://localhost:${PORT}`,
    network: ips.map(i => ({ iface: i.name, url: `${proto}://${i.address}:${PORT}` })),
    platform: os.platform(),
    arch: os.arch(),
    hostname: os.hostname(),
    uptime: Math.floor(process.uptime()),
    onlineClients: clients.size,
  });
});

server.listen(PORT, '0.0.0.0', () => {
  const ips = getLanIPs();
  const line = '─'.repeat(52);
  console.log(`\n  ${line}`);
  console.log(`  │  🌊  FlowToIt Server`);
  console.log(`  ${line}`);
  console.log(`  │  Local:    ${proto}://localhost:${PORT}`);
  if (ips.length > 0) {
    ips.forEach(ip => {
      console.log(`  │  Network:  ${proto}://${ip.address}:${PORT}  (${ip.name})`);
    });
  } else {
    console.log(`  │  Network:  No LAN IP detected — check Wi-Fi`);
  }
  console.log(`  │  Platform: ${os.platform()} ${os.arch()}`);
  console.log(`  ${line}`);
  if (proto === 'https') {
    console.log(`  │  ⚠  Self-signed cert — browsers show a warning`);
    console.log(`  │  Tap "Advanced" → "Proceed" to accept it`);
    console.log(`  ${line}`);
  }
  console.log(`  │  Share the Network URL with devices on your LAN`);
  console.log(`  ${line}\n`);
});
