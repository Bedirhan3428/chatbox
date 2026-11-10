'use strict';
/**
 * Ultra hafif signaling sunucusu (Render free tier, 512 MB).
 * Medya bu sunucudan GEÇMEZ; yalnızca SDP/ICE JSON'larını odadaki hedef peer'e iletir.
 */
const http = require('http');
const crypto = require('crypto');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = Number(process.env.PORT) || 8080;
const MAX_ROOM_SIZE = Number(process.env.MAX_ROOM_SIZE) || 4;
const HEARTBEAT_MS = 30_000;
const MAX_PAYLOAD = 64 * 1024; // SDP ~5-10 KB; fazlası reddedilir
const ROOM_RE = /^[a-zA-Z0-9_-]{3,32}$/;

/** @type {Map<string, Map<string, WebSocket>>} roomId -> (peerId -> socket) */
const rooms = new Map();

const server = http.createServer((req, res) => {
  // Render health check + uyandırma isteği
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size, clients: wss.clients.size }));
    return;
  }
  res.writeHead(404).end();
});

const wss = new WebSocketServer({ server, maxPayload: MAX_PAYLOAD, perMessageDeflate: false });

function send(ws, msg) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function leaveRoom(ws) {
  const { roomId, id } = ws;
  if (!roomId) return;
  const room = rooms.get(roomId);
  ws.roomId = null;
  if (!room) return;
  room.delete(id);
  if (room.size === 0) rooms.delete(roomId);
  else room.forEach((peer) => send(peer, { type: 'peer-left', id }));
}

wss.on('connection', (ws) => {
  ws.id = crypto.randomBytes(8).toString('hex');
  ws.name = 'Misafir';
  ws.roomId = null;
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));

  ws.on('message', (raw) => {
    ws.isAlive = true;
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return send(ws, { type: 'error', code: 'BAD_REQUEST', message: 'invalid json' });
    }

    switch (msg.type) {
      case 'ping':
        return send(ws, { type: 'pong', t: msg.t });

      case 'join': {
        if (typeof msg.roomId !== 'string' || !ROOM_RE.test(msg.roomId)) {
          return send(ws, { type: 'error', code: 'BAD_REQUEST', message: 'invalid roomId' });
        }
        leaveRoom(ws);
        const room = rooms.get(msg.roomId) ?? new Map();
        if (room.size >= MAX_ROOM_SIZE) return send(ws, { type: 'error', code: 'ROOM_FULL' });

        ws.name = String(msg.name ?? 'Misafir').slice(0, 24) || 'Misafir';
        ws.roomId = msg.roomId;
        const peers = [...room.values()].map((p) => ({ id: p.id, name: p.name }));
        room.forEach((p) => send(p, { type: 'peer-joined', peer: { id: ws.id, name: ws.name } }));
        room.set(ws.id, ws);
        rooms.set(msg.roomId, room);
        return send(ws, { type: 'joined', selfId: ws.id, roomId: msg.roomId, peers });
      }

      case 'signal': {
        const target = ws.roomId && rooms.get(ws.roomId)?.get(msg.to);
        if (!target) return send(ws, { type: 'error', code: 'NOT_IN_ROOM' });
        return send(target, { type: 'signal', from: ws.id, data: msg.data });
      }

      case 'leave':
        return leaveRoom(ws);
    }
  });

  ws.on('close', () => leaveRoom(ws));
  ws.on('error', () => ws.terminate());
});

// Ölü soketleri temizle (mobil ağ değişimi, uygulama öldürülmesi)
const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, HEARTBEAT_MS);

wss.on('close', () => clearInterval(heartbeat));

function shutdown() {
  wss.clients.forEach((ws) => ws.close(1001, 'server restart'));
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3_000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

server.listen(PORT, () => console.log(`signaling listening on :${PORT}`));
