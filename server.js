const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const path = require("path");

const app = express();
app.use(express.static(path.join(__dirname, "public")));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: "/ws" });

// roomCode -> {
//   hostId,
//   clients: Map(clientId->ws),
//   state,
//   version,
//   seats: { p1: clientId|null, p2:..., p3:..., p4:... },
//   clientSeat: Map(clientId->seatString)  // "p1"|"p2"|"p3"|"p4"|"spec"
// }
const rooms = new Map();

function makeCode() {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 5; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function safeSend(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function broadcast(room, obj) {
  const data = JSON.stringify(obj);
  for (const ws of room.clients.values()) {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  }
}

function systemChat(room, text) {
  const t = String(text || "").trim();
  if (!t) return;
  broadcast(room, {
    type: "CHAT",
    ts: Date.now(),
    system: true,
    text: t
  });
}

function emitPresence(room, roomCode) {
  broadcast(room, {
    type: "PRESENCE",
    roomCode,
    hostId: room.hostId,
    clients: [...room.clients.keys()],
    seats: room.seats
  });
}

// ===== Chat helpers (ephemeral) =====
function cleanText(s) {
  s = String(s || "");
  s = s.replace(/[\u0000-\u001F\u007F]/g, ""); // strip control chars
  s = s.replace(/\s+/g, " ").trim();           // collapse whitespace
  if (s.length > 220) s = s.slice(0, 220);     // limit length
  return s;
}

// per-client simple rate limit: 6 msgs / 8s
const chatRL = new Map(); // clientId -> { windowStartMs, count }
function allowChat(clientId) {
  const now = Date.now();
  const winMs = 8000;
  const max = 6;

  const cur = chatRL.get(clientId);
  if (!cur || (now - cur.windowStartMs) > winMs) {
    chatRL.set(clientId, { windowStartMs: now, count: 1 });
    return true;
  }
  if (cur.count >= max) return false;
  cur.count++;
  return true;
}

function getRoomFromWs(ws) {
  const roomCode = ws._room;
  if (!roomCode) return { roomCode: null, room: null };
  const room = rooms.get(roomCode);
  if (!room) return { roomCode: null, room: null };
  return { roomCode, room };
}

wss.on("connection", (ws) => {
  const clientId = (Date.now().toString(16) + Math.random().toString(16).slice(2)).slice(0, 16);
  ws._clientId = clientId;
  ws._room = null;

  safeSend(ws, { type: "HELLO", clientId });

  ws.on("message", (buf) => {
    let msg;
    try { msg = JSON.parse(buf.toString()); } catch { return; }

    // ----------------------------
    // Create a room (host)
    // ----------------------------
    if (msg.type === "CREATE_ROOM") {
      let roomCode = makeCode();
      while (rooms.has(roomCode)) roomCode = makeCode();

      const room = {
        hostId: clientId,
        clients: new Map(),
        state: null,
        version: 0,
        seats: { p1: null, p2: null, p3: null, p4: null },
        clientSeat: new Map()
      };

      rooms.set(roomCode, room);
      room.clients.set(clientId, ws);
      ws._room = roomCode;

      safeSend(ws, { type: "ROOM_CREATED", roomCode, hostId: clientId, clientId });
      systemChat(room, "Room created. Host connected.");
      emitPresence(room, roomCode);
      return;
    }

    // ----------------------------
    // Join a room (guest)
    // ----------------------------
    if (msg.type === "JOIN_ROOM") {
      const roomCode = String(msg.roomCode || "").toUpperCase();
      const room = rooms.get(roomCode);
      if (!room) { safeSend(ws, { type: "ERROR", message: "Room not found" }); return; }

      room.clients.set(clientId, ws);
      ws._room = roomCode;

      safeSend(ws, { type: "ROOM_JOINED", roomCode, hostId: room.hostId, clientId });
      if (room.state) safeSend(ws, { type: "STATE", version: room.version, state: room.state });

      systemChat(room, "A player joined the room.");
      emitPresence(room, roomCode);
      return;
    }

    // ----------------------------
    // Must be in a room from here down
    // ----------------------------
    const { roomCode, room } = getRoomFromWs(ws);
    if (!roomCode || !room) return;

    // ----------------------------
    // Host publishes authoritative state
    // ----------------------------
    if (msg.type === "PUBLISH_STATE") {
      if (clientId !== room.hostId) return;
      if (typeof msg.version !== "number") return;
      if (msg.version <= room.version) return;

      room.state = msg.state;
      room.version = msg.version;

      broadcast(room, { type: "STATE", version: room.version, state: room.state });
      return;
    }

    // ----------------------------
    // Guests send action -> forwarded to host
    // ----------------------------
    if (msg.type === "ACTION") {
      const hostWs = room.clients.get(room.hostId);
      if (hostWs) safeSend(hostWs, { type: "ACTION", from: clientId, action: msg.action });
      return;
    }

    // ----------------------------
    // Ephemeral chat: broadcast to room
    // ----------------------------
    if (msg.type === "CHAT") {
      if (!allowChat(clientId)) {
        safeSend(ws, { type: "ERROR", message: "Chat rate limit. Slow down." });
        return;
      }

      const text = cleanText(msg.text);
      if (!text) return;

      // derive seat from server truth (fallback to client-provided)
      const seat = room.clientSeat.get(clientId) || String(msg.seat || "spec").toLowerCase();

      let name = cleanText(msg.name);
      if (name.length > 16) name = name.slice(0, 16);

      broadcast(room, {
        type: "CHAT",
        ts: Date.now(),
        from: clientId,
        seat,
        name,
        text
      });
      return;
    }

    // ----------------------------
    // Claim a seat (true multiplayer)
    // ----------------------------
    if (msg.type === "CLAIM_SEAT") {
      const want = String(msg.seat || "").toLowerCase(); // "p1"|"p2"|"p3"|"p4"|"spec"
      if (!["p1","p2","p3","p4","spec"].includes(want)) {
        safeSend(ws, { type: "ERROR", message: "Invalid seat" });
        return;
      }

      // Release existing seat (if any)
      const prev = room.clientSeat.get(clientId);
      if (prev && ["p1","p2","p3","p4"].includes(prev) && room.seats[prev] === clientId) {
        room.seats[prev] = null;
      }

      // Spectator
      if (want === "spec") {
        room.clientSeat.set(clientId, "spec");
        safeSend(ws, { type: "SEAT_CLAIMED", seat: "spec" });
        systemChat(room, "A player is now spectating.");
        emitPresence(room, roomCode);
        return;
      }

      // Claim seat if available (or already owned by same client)
      if (room.seats[want] && room.seats[want] !== clientId) {
        safeSend(ws, { type: "SEAT_REJECTED", seat: want, reason: "Seat already taken" });
        emitPresence(room, roomCode);
        return;
      }

      room.seats[want] = clientId;
      room.clientSeat.set(clientId, want);
      safeSend(ws, { type: "SEAT_CLAIMED", seat: want });

      systemChat(room, `Seat ${want.toUpperCase()} claimed.`);
      emitPresence(room, roomCode);
      return;
    }
  });

  ws.on("close", () => {
    const { roomCode, room } = getRoomFromWs(ws);
    if (!roomCode || !room) return;

    room.clients.delete(clientId);

    // release seat if held
    const held = room.clientSeat.get(clientId);
    if (held && ["p1","p2","p3","p4"].includes(held) && room.seats[held] === clientId) {
      room.seats[held] = null;
    }
    room.clientSeat.delete(clientId);

    // delete empty room
    if (room.clients.size === 0) {
      rooms.delete(roomCode);
      return;
    }

    systemChat(room, "A player left the room.");

    // If host left, promote first remaining client to host
    if (!room.clients.has(room.hostId)) {
      const newHostId = room.clients.keys().next().value;
      room.hostId = newHostId;

      broadcast(room, { type: "HOST_CHANGED", hostId: room.hostId });
      systemChat(room, "Host changed.");
    }

    emitPresence(room, roomCode);
  });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log("Server running on port", PORT);
  console.log("WebSocket endpoint /ws");
});
