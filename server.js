const express = require('express');
const { WebSocketServer } = require('ws');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const https = require('https');
const http = require('http');
const os = require('os');
const forge = require('node-forge');
const { exec } = require('child_process');

const app = express();

// ── Pfad für statische Dateien (funktioniert sowohl normal als auch als .exe) ──
// Wenn pkg-exe: public-Ordner liegt neben der .exe
// Wenn normal:  public-Ordner liegt neben server.js
const isPkg = typeof process.pkg !== 'undefined';
const staticRoot = isPkg
  ? path.join(path.dirname(process.execPath), 'public')
  : path.join(__dirname, 'public');

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

const pems  = generateCert(getLocalIPs());
const server = https.createServer({ key: pems.key, cert: pems.cert }, app);
const wss   = new WebSocketServer({ server });

// HTTP → HTTPS Redirect
http.createServer((req, res) => {
  res.writeHead(301, { Location: `https://${req.headers.host.split(':')[0]}:${PORT}${req.url}` });
  res.end();
}).listen(80, '0.0.0.0').on('error', () => { /* Port 80 nicht verfügbar – kein Problem */ });

app.use(express.static(staticRoot));

// ── API: Server-Info (LAN-IP für die Lobby-Anzeige) ──────────────────────
app.get('/api/info', (req, res) => {
  res.json({ ips: getLocalIPs(), port: PORT });
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

wss.on('connection', (ws) => {
  const clientId = uuidv4();
  let currentRoom = null;
  let username = 'Anonymous';

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
        username = (msg.username || 'Nutzer').slice(0, 30);

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
        username = (msg.username || 'Nutzer').slice(0, 30);

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

const PORT = process.env.PORT || 3443;
server.listen(PORT, '0.0.0.0', () => {
  const ips = getLocalIPs();
  const localUrl = `https://localhost:${PORT}`;

  console.log('\n🎙️  LAN Voice Server gestartet! (HTTPS)\n');
  console.log(`   Lokal:    ${localUrl}`);
  ips.forEach(ip => console.log(`   Netzwerk: https://${ip}:${PORT}`));
  console.log('');
  console.log('   ⚠️  Beim ersten Aufruf im Browser:');
  console.log('      Chrome/Edge → "Erweitert" → "Weiter zu <IP>"');
  console.log('      Firefox    → "Risiko akzeptieren und fortfahren"');
  console.log('\n   Teile die Netzwerk-URL mit anderen Geräten im LAN.\n');
  console.log('   [Fenster offen lassen – Server läuft solange dieses Fenster offen ist]\n');

  // Browser automatisch öffnen
  const openCmd = process.platform === 'win32' ? `start ${localUrl}` :
                  process.platform === 'darwin' ? `open ${localUrl}` :
                  `xdg-open ${localUrl}`;
  exec(openCmd, (err) => { if (err) console.log('   (Browser konnte nicht automatisch geöffnet werden)'); });
});
