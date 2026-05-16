const express = require('express');
const { WebSocketServer } = require('ws');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const os = require('os');
const forge = require('node-forge');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { exec } = require('child_process');

require('dotenv').config();

const app = express();
app.use(express.json());

// ── Pfad für statische Dateien (funktioniert sowohl normal als auch als .exe) ──
// Wenn pkg-exe: public-Ordner liegt neben der .exe
// Wenn normal:  public-Ordner liegt neben server.js
const isPkg = typeof process.pkg !== 'undefined';
const staticRoot = isPkg
  ? path.join(path.dirname(process.execPath), 'public')
  : path.join(__dirname, 'public');

const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production';
const ADMIN_USERNAME = sanitizeUsername(process.env.ADMIN_USERNAME || '');
const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || '');
const AUTH_ENABLED = String(process.env.AUTH_ENABLED || 'true').toLowerCase() !== 'false';
const TLS_ENABLED  = String(process.env.SERVER_TLS_ENABLED || 'true').toLowerCase() !== 'false';
const USERS_FILE = isPkg
  ? path.join(path.dirname(process.execPath), 'data', 'users.json')
  : path.join(__dirname, 'data', 'users.json');

function ensureUsersStore() {
  const dir = path.dirname(USERS_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (!fs.existsSync(USERS_FILE)) {
    fs.writeFileSync(USERS_FILE, JSON.stringify({ users: [] }, null, 2), 'utf8');
  }
}

function readUsers() {
  ensureUsersStore();
  try {
    const raw = fs.readFileSync(USERS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.users)) return [];
    return parsed.users;
  } catch {
    return [];
  }
}

function writeUsers(users) {
  ensureUsersStore();
  fs.writeFileSync(USERS_FILE, JSON.stringify({ users }, null, 2), 'utf8');
}

function sanitizeUsername(value) {
  return String(value || '').trim().slice(0, 30);
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    role: user.role || 'user',
    isActive: user.isActive !== false,
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt || null
  };
}

function countActiveAdmins(users) {
  return users.filter(u => (u.role || 'user') === 'admin' && u.isActive !== false).length;
}

function normalizeUser(user) {
  return {
    ...user,
    role: user.role || 'user',
    isActive: user.isActive !== false
  };
}

function issueToken(user) {
  return jwt.sign({ sub: user.id, username: user.username, role: user.role || 'user' }, JWT_SECRET, { expiresIn: '7d' });
}

function authFromReq(req) {
  const authHeader = req.headers.authorization || '';
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  try {
    return jwt.verify(match[1], JWT_SECRET);
  } catch {
    return null;
  }
}

function parseWsToken(req) {
  try {
    const base = `https://${req.headers.host || 'localhost'}`;
    const url = new URL(req.url || '/', base);
    return url.searchParams.get('token') || '';
  } catch {
    return '';
  }
}

function authUserFromReq(req) {
  const payload = authFromReq(req);
  if (!payload) return null;
  const users = readUsers().map(normalizeUser);
  const user = users.find(u => u.id === payload.sub);
  if (!user || user.isActive === false) return null;
  return user;
}

function requireAuth(req, res, next) {
  if (!AUTH_ENABLED) {
    return res.status(403).json({ message: 'Auth ist deaktiviert (LAN-Modus).' });
  }
  const user = authUserFromReq(req);
  if (!user) return res.status(401).json({ message: 'Nicht autorisiert.' });
  req.user = user;
  return next();
}

function requireAdmin(req, res, next) {
  if ((req.user.role || 'user') !== 'admin') {
    return res.status(403).json({ message: 'Admin-Rechte erforderlich.' });
  }
  return next();
}

async function bootstrapAdminIfConfigured() {
  ensureUsersStore();
  if (!ADMIN_USERNAME || !ADMIN_PASSWORD) return;
  if (ADMIN_USERNAME.length < 3 || ADMIN_PASSWORD.length < 8) {
    console.log('⚠️  ADMIN_USERNAME/ADMIN_PASSWORD sind gesetzt, aber nicht valide (min 3/8 Zeichen).');
    return;
  }

  const users = readUsers().map(normalizeUser);
  const existing = users.find(u => u.username.toLowerCase() === ADMIN_USERNAME.toLowerCase());
  if (existing) {
    existing.passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 10);
    existing.role = 'admin';
    existing.isActive = true;
    users.splice(users.findIndex(u => u.id === existing.id), 1, existing);
    writeUsers(users);
    console.log(`🔧 Admin-Bootstrap: vorhandener Nutzer "${existing.username}" als Admin/PW synchronisiert.`);
    return;
  }

  const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 10);
  users.push({
    id: uuidv4(),
    username: ADMIN_USERNAME,
    passwordHash,
    role: 'admin',
    isActive: true,
    createdAt: new Date().toISOString(),
    lastLoginAt: null
  });
  writeUsers(users);
  console.log(`🔧 Admin-Bootstrap: Admin "${ADMIN_USERNAME}" erstellt.`);
}

// ── Auth API ────────────────────────────────────────────────────────────
app.post('/api/auth/register', async (req, res) => {
  if (!AUTH_ENABLED) {
    return res.status(403).json({ message: 'Auth ist deaktiviert (LAN-Modus).' });
  }
  return res.status(403).json({ message: 'Registrierung ist deaktiviert. Bitte Admin kontaktieren.' });
});

app.post('/api/auth/login', async (req, res) => {
  if (!AUTH_ENABLED) {
    return res.status(403).json({ message: 'Login ist deaktiviert (LAN-Modus).' });
  }
  const username = sanitizeUsername(req.body && req.body.username);
  const password = String((req.body && req.body.password) || '');

  const users = readUsers().map(normalizeUser);
  const user = users.find(u => u.username.toLowerCase() === username.toLowerCase());
  if (!user) {
    return res.status(401).json({ message: 'Ungültiger Benutzername oder Passwort.' });
  }
  if (user.isActive === false) {
    return res.status(403).json({ message: 'Benutzer ist deaktiviert.' });
  }

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) {
    return res.status(401).json({ message: 'Ungültiger Benutzername oder Passwort.' });
  }

  user.lastLoginAt = new Date().toISOString();
  writeUsers(users);

  const token = issueToken(user);
  return res.json({ token, user: publicUser(user) });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  return res.json({ user: publicUser(req.user) });
});

// ── Admin API ───────────────────────────────────────────────────────────
app.get('/api/admin/users', requireAuth, requireAdmin, (req, res) => {
  const users = readUsers().map(normalizeUser).map(publicUser);
  return res.json({ users });
});

app.post('/api/admin/users', requireAuth, requireAdmin, async (req, res) => {
  const username = sanitizeUsername(req.body && req.body.username);
  const password = String((req.body && req.body.password) || '');
  const role = req.body && req.body.role === 'admin' ? 'admin' : 'user';

  if (username.length < 3) {
    return res.status(400).json({ message: 'Benutzername muss mindestens 3 Zeichen haben.' });
  }
  if (password.length < 8) {
    return res.status(400).json({ message: 'Passwort muss mindestens 8 Zeichen haben.' });
  }

  const users = readUsers().map(normalizeUser);
  const exists = users.some(u => u.username.toLowerCase() === username.toLowerCase());
  if (exists) {
    return res.status(409).json({ message: 'Benutzername ist bereits vergeben.' });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const user = {
    id: uuidv4(),
    username,
    passwordHash,
    role,
    isActive: true,
    createdAt: new Date().toISOString(),
    lastLoginAt: null
  };

  users.push(user);
  writeUsers(users);
  return res.status(201).json({ user: publicUser(user) });
});

app.patch('/api/admin/users/:id', requireAuth, requireAdmin, async (req, res) => {
  const users = readUsers().map(normalizeUser);
  const idx = users.findIndex(u => u.id === req.params.id);
  if (idx === -1) return res.status(404).json({ message: 'Nutzer nicht gefunden.' });

  const target = users[idx];
  const { role, isActive, password } = req.body || {};

  if (target.id === req.user.id && (role || typeof isActive === 'boolean')) {
    return res.status(400).json({ message: 'Eigene Rolle/Aktivstatus kann nicht geändert werden.' });
  }

  if (typeof role === 'string') {
    if (role !== 'user' && role !== 'admin') {
      return res.status(400).json({ message: 'Ungültige Rolle.' });
    }
    if (target.role === 'admin' && role !== 'admin' && countActiveAdmins(users) <= 1) {
      return res.status(400).json({ message: 'Mindestens ein aktiver Admin ist erforderlich.' });
    }
    target.role = role;
  }

  if (typeof isActive === 'boolean') {
    if (target.role === 'admin' && isActive === false && countActiveAdmins(users) <= 1) {
      return res.status(400).json({ message: 'Letzter aktiver Admin kann nicht deaktiviert werden.' });
    }
    target.isActive = isActive;
  }

  if (typeof password === 'string') {
    if (password.length < 8) {
      return res.status(400).json({ message: 'Passwort muss mindestens 8 Zeichen haben.' });
    }
    target.passwordHash = await bcrypt.hash(password, 10);
  }

  users[idx] = target;
  writeUsers(users);
  return res.json({ user: publicUser(target) });
});

app.delete('/api/admin/users/:id', requireAuth, requireAdmin, (req, res) => {
  const users = readUsers().map(normalizeUser);
  const idx = users.findIndex(u => u.id === req.params.id);
  if (idx === -1) return res.status(404).json({ message: 'Nutzer nicht gefunden.' });

  const target = users[idx];
  if (target.id === req.user.id) {
    return res.status(400).json({ message: 'Eigener Nutzer kann nicht gelöscht werden.' });
  }
  if (target.role === 'admin' && target.isActive !== false && countActiveAdmins(users) <= 1) {
    return res.status(400).json({ message: 'Letzter aktiver Admin kann nicht gelöscht werden.' });
  }

  users.splice(idx, 1);
  writeUsers(users);
  return res.status(204).send();
});

// ── Selbst-signiertes Zertifikat generieren (node-forge, Chrome-kompatibel) ──
console.log('🔐 Generiere TLS-Zertifikat…');

function generateCert(ips) {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();

  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date();
  cert.validity.notAfter  = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1);

  const attrs = [
    { name: 'commonName',         value: 'lan-voice.local' },
    { name: 'organizationName',   value: 'LAN Voice' },
    { name: 'countryName',        value: 'DE' },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);

  const altNames = [
    { type: 2, value: 'localhost' },
    { type: 7, ip: '127.0.0.1' },
    ...ips.map(ip => ({ type: 7, ip }))
  ];

  cert.setExtensions([
    { name: 'basicConstraints', cA: true },
    { name: 'keyUsage', keyCertSign: true, digitalSignature: true, keyEncipherment: true },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectAltName', altNames }
  ]);

  cert.sign(keys.privateKey, forge.md.sha256.create());

  return {
    key:  forge.pki.privateKeyToPem(keys.privateKey),
    cert: forge.pki.certificateToPem(cert)
  };
}

let server;
if (TLS_ENABLED) {
  console.log('🔐 Generiere TLS-Zertifikat…');
  const pems = generateCert(getLocalIPs());
  server = https.createServer({ key: pems.key, cert: pems.cert }, app);
  // HTTP → HTTPS Redirect
  http.createServer((req, res) => {
    res.writeHead(301, { Location: `https://${req.headers.host.split(':')[0]}:${PORT}${req.url}` });
    res.end();
  }).listen(80, '0.0.0.0').on('error', () => { /* Port 80 nicht verfügbar – kein Problem */ });
} else {
  server = http.createServer(app);
}
const wss = new WebSocketServer({ server });

app.use(express.static(staticRoot));

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.get('/admin', (req, res) => {
  res.sendFile(path.join(staticRoot, 'admin.html'));
});

// ── API: Server-Info (LAN-IP für die Lobby-Anzeige) ──────────────────────
app.get('/api/info', (req, res) => {
  res.json({ ips: getLocalIPs(), port: PORT });
});

app.get('/api/config', (req, res) => {
  res.json({ authEnabled: AUTH_ENABLED });
});

// Rooms: { roomId: { name, clients: Map<clientId, { ws, username, muted }> } }
const rooms = new Map();

function getLocalIPs() {
  const interfaces = os.networkInterfaces();
  const ips = [];
  for (const iface of Object.values(interfaces)) {
    for (const alias of iface) {
      if (alias.family === 'IPv4' && !alias.internal) {
        ips.push(alias.address);
      }
    }
  }
  return ips;
}

// Wird vor createServer aufgerufen – IPs müssen hier schon verfügbar sein
// (getLocalIPs ist hoist-safe da function declaration)

function broadcast(room, message, excludeId = null) {
  if (!rooms.has(room)) return;
  const clients = rooms.get(room).clients;
  const data = JSON.stringify(message);
  for (const [id, client] of clients) {
    if (id !== excludeId && client.ws.readyState === 1) {
      client.ws.send(data);
    }
  }
}

function getRoomList() {
  const list = [];
  for (const [id, room] of rooms) {
    list.push({
      id,
      name: room.name,
      participants: room.clients.size
    });
  }
  return list;
}

function broadcastRoomList() {
  // Send updated room list to all connected clients not in a room
  const list = getRoomList();
  for (const [, room] of rooms) {
    for (const [, client] of room.clients) {
      if (client.ws.readyState === 1) {
        client.ws.send(JSON.stringify({ type: 'room_list', rooms: list }));
      }
    }
  }
  // Also send to lobby clients
  for (const client of lobbyClients) {
    if (client.readyState === 1) {
      client.send(JSON.stringify({ type: 'room_list', rooms: list }));
    }
  }
}

const lobbyClients = new Set();

wss.on('connection', (ws, req) => {
  let user = null;
  if (AUTH_ENABLED) {
    const token = parseWsToken(req);
    const payload = (() => {
      try {
        return jwt.verify(token, JWT_SECRET);
      } catch {
        return null;
      }
    })();
    if (!payload) {
      ws.close(1008, 'unauthorized');
      return;
    }

    user = readUsers().map(normalizeUser).find(u => u.id === payload.sub);
    if (!user || user.isActive === false) {
      ws.close(1008, 'unauthorized');
      return;
    }
  }

  const clientId = uuidv4();
  let currentRoom = null;
  let username = user ? user.username : 'Nutzer';

  lobbyClients.add(ws);

  // Send initial room list
  ws.send(JSON.stringify({ type: 'room_list', rooms: getRoomList() }));
  ws.send(JSON.stringify({ type: 'your_id', id: clientId }));

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      case 'create_room': {
        const roomId = uuidv4().slice(0, 6).toUpperCase();
        const roomName = (msg.name || 'Raum').slice(0, 40);
        if (!AUTH_ENABLED) {
          username = sanitizeUsername(msg.username || 'Nutzer') || 'Nutzer';
        }

        rooms.set(roomId, { name: roomName, clients: new Map() });
        rooms.get(roomId).clients.set(clientId, { ws, username, muted: false });

        currentRoom = roomId;
        lobbyClients.delete(ws);

        ws.send(JSON.stringify({
          type: 'joined_room',
          roomId,
          roomName,
          clientId,
          participants: [{ id: clientId, username, muted: false }]
        }));

        broadcastRoomList();
        break;
      }

      case 'join_room': {
        const roomId = msg.roomId;
        if (!AUTH_ENABLED) {
          username = sanitizeUsername(msg.username || 'Nutzer') || 'Nutzer';
        }

        if (!rooms.has(roomId)) {
          ws.send(JSON.stringify({ type: 'error', message: 'Raum nicht gefunden.' }));
          return;
        }

        const room = rooms.get(roomId);
        room.clients.set(clientId, { ws, username, muted: false });
        currentRoom = roomId;
        lobbyClients.delete(ws);

        const participants = [...room.clients.entries()].map(([id, c]) => ({
          id, username: c.username, muted: c.muted
        }));

        ws.send(JSON.stringify({
          type: 'joined_room',
          roomId,
          roomName: room.name,
          clientId,
          participants
        }));

        // Notify others
        broadcast(roomId, {
          type: 'participant_joined',
          id: clientId,
          username,
          muted: false
        }, clientId);

        broadcastRoomList();
        break;
      }

      case 'leave_room': {
        handleLeave();
        break;
      }

      case 'offer':
      case 'answer':
      case 'ice_candidate': {
        if (!currentRoom || !rooms.has(currentRoom)) return;
        const target = rooms.get(currentRoom).clients.get(msg.to);
        if (target && target.ws.readyState === 1) {
          target.ws.send(JSON.stringify({ ...msg, from: clientId }));
        }
        break;
      }

      case 'mute_status': {
        if (!currentRoom || !rooms.has(currentRoom)) return;
        const room = rooms.get(currentRoom);
        if (room.clients.has(clientId)) {
          room.clients.get(clientId).muted = msg.muted;
        }
        broadcast(currentRoom, {
          type: 'participant_muted',
          id: clientId,
          muted: msg.muted
        }, clientId);
        break;
      }

      case 'chat_message': {
        if (!currentRoom) return;
        broadcast(currentRoom, {
          type: 'chat_message',
          from: clientId,
          username,
          text: (msg.text || '').slice(0, 500)
        }, clientId);
        break;
      }
    }
  });

  function handleLeave() {
    if (currentRoom && rooms.has(currentRoom)) {
      const room = rooms.get(currentRoom);
      room.clients.delete(clientId);

      broadcast(currentRoom, { type: 'participant_left', id: clientId });

      if (room.clients.size === 0) {
        rooms.delete(currentRoom);
      }

      broadcastRoomList();
      currentRoom = null;
    }
    lobbyClients.add(ws);
    ws.send(JSON.stringify({ type: 'left_room', rooms: getRoomList() }));
  }

  ws.on('close', () => {
    lobbyClients.delete(ws);
    if (currentRoom && rooms.has(currentRoom)) {
      rooms.get(currentRoom).clients.delete(clientId);
      broadcast(currentRoom, { type: 'participant_left', id: clientId });
      if (rooms.get(currentRoom).clients.size === 0) {
        rooms.delete(currentRoom);
      }
      broadcastRoomList();
    }
  });
});

const PORT = process.env.PORT || 3000;
async function start() {
  if (AUTH_ENABLED) {
    await bootstrapAdminIfConfigured();
  }

  server.listen(PORT, '0.0.0.0', () => {
    const ips = getLocalIPs();
    const proto = TLS_ENABLED ? 'https' : 'http';
    const localUrl = `${proto}://localhost:${PORT}`;

    console.log(`\n🎙️  LAN Voice Server gestartet! (${TLS_ENABLED ? 'HTTPS' : 'HTTP'})\n`);
    console.log(`   Lokal:    ${localUrl}`);
    ips.forEach(ip => console.log(`   Netzwerk: ${proto}://${ip}:${PORT}`));
    console.log('');
    console.log(`   Modus:    ${AUTH_ENABLED ? 'Internet (mit Login)' : 'LAN (ohne Login)'}`);
    if (TLS_ENABLED) {
      console.log('   ⚠️  Beim ersten Aufruf im Browser:');
      console.log('      Chrome/Edge → "Erweitert" → "Weiter zu <IP>"');
      console.log('      Firefox    → "Risiko akzeptieren und fortfahren"');
    }
    console.log('\n   Teile die Netzwerk-URL mit anderen Geräten im LAN.\n');
    console.log('   [Fenster offen lassen – Server läuft solange dieses Fenster offen ist]\n');

    // Browser automatisch öffnen (nur lokal sinnvoll)
    if (process.platform === 'win32' || process.platform === 'darwin') {
      const openCmd = process.platform === 'win32' ? `start ${localUrl}` : `open ${localUrl}`;
      exec(openCmd, (err) => { if (err) console.log('   (Browser konnte nicht automatisch geöffnet werden)'); });
    }
  });
}

start().catch((err) => {
  console.error('Serverstart fehlgeschlagen:', err);
  process.exit(1);
});
