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
//   clientSeat: Map(clientId->seatString)  // seatString: "p1"|"p2"|"p3"|"p4"|"spec"
// }
const rooms = new Map();

function makeCode() {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 5; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}
function safeSend(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}
function broadcast(room, obj) {
  const data = JSON.stringify(obj);
  for (const ws of room.clients.values()) {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  }
}
function emitPresence(room, roomCode) {
  broadcast(room, {
    type: "PRESENCE",
    roomCode,
    clients: [...room.clients.keys()],
    seats: room.seats
  });
}

wss.on("connection", (ws) => {
  const clientId = Math.random().toString(16).slice(2);
  ws._clientId = clientId;
  ws._room = null;

  safeSend(ws, { type: "HELLO", clientId });

  ws.on("message", (buf) => {
    let msg;
    try { msg = JSON.parse(buf.toString()); } catch { return; }

    // Create a room (host)
    if (msg.type === "CREATE_ROOM") {
      let code = makeCode();
      while (rooms.has(code)) code = makeCode();

      const room = {
        hostId: clientId,
        clients: new Map(),
        state: null,
        version: 0,
        seats: { p1: null, p2: null, p3: null, p4: null },
        clientSeat: new Map()
      };
      rooms.set(code, room);

      room.clients.set(clientId, ws);
      ws._room = code;

      safeSend(ws, { type: "ROOM_CREATED", roomCode: code, hostId: clientId, clientId });

      emitPresence(room, code);
      return;
    }

    // Join a room (guest)
    if (msg.type === "JOIN_ROOM") {
      const code = String(msg.roomCode || "").toUpperCase();
      const room = rooms.get(code);
      if (!room) { safeSend(ws, { type: "ERROR", message: "Room not found" }); return; }

      room.clients.set(clientId, ws);
      ws._room = code;

      safeSend(ws, { type: "ROOM_JOINED", roomCode: code, hostId: room.hostId, clientId });
      if (room.state) safeSend(ws, { type: "STATE", version: room.version, state: room.state });

      emitPresence(room, code);
      return;
    }

    // Must be in a room for messages below
    const code = ws._room;
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;

    // Host publishes authoritative state
    if (msg.type === "PUBLISH_STATE") {
      if (clientId !== room.hostId) return;
      room.state = msg.state;
      room.version++;
      broadcast(room, { type: "STATE", version: room.version, state: room.state });
      return;
    }

    // Guests send action -> forwarded to host
    if (msg.type === "ACTION") {
      const hostWs = room.clients.get(room.hostId);
      if (hostWs) safeSend(hostWs, { type: "ACTION", from: clientId, action: msg.action });
      return;
    }

    // Claim a seat (true multiplayer)
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

      // If spectator, just set and broadcast
      if (want === "spec") {
        room.clientSeat.set(clientId, "spec");
        safeSend(ws, { type: "SEAT_CLAIMED", seat: "spec" });
        emitPresence(room, code);
        return;
      }

      // Claim actual seat if available or already owned by same client
      if (room.seats[want] && room.seats[want] !== clientId) {
        safeSend(ws, { type: "SEAT_REJECTED", seat: want, reason: "Seat already taken" });
        emitPresence(room, code);
        return;
      }

      room.seats[want] = clientId;
      room.clientSeat.set(clientId, want);
      safeSend(ws, { type: "SEAT_CLAIMED", seat: want });
      emitPresence(room, code);
      return;
    }
  });

  ws.on("close", () => {
    const code = ws._room;
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;

    room.clients.delete(clientId);

    // release seat if held
    const held = room.clientSeat.get(clientId);
    if (held && ["p1","p2","p3","p4"].includes(held) && room.seats[held] === clientId) {
      room.seats[held] = null;
    }
    room.clientSeat.delete(clientId);

    if (room.clients.size === 0) rooms.delete(code);
    else emitPresence(room, code);
  });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log("Server running on port", PORT);
  console.log("WebSocket endpoint /ws");
});
