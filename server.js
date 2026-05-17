const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 50 * 1024 * 1024 });

app.use(express.static(path.join(__dirname, 'public')));

const SPEED_DIAL_CODES = new Map();
const SOCKET_CODES = new Map();
const PAIRED_ROOMS = new Map();

function generateCode() {
  let code;
  do {
    code = String(Math.floor(1000 + Math.random() * 9000));
  } while (SPEED_DIAL_CODES.has(code));
  return code;
}

function cleanupPairing(socketId) {
  for (const [room, peers] of PAIRED_ROOMS) {
    if (peers.includes(socketId)) {
      const peerId = peers.find(id => id !== socketId);
      PAIRED_ROOMS.delete(room);
      if (peerId) {
        const peerCode = SOCKET_CODES.get(peerId);
        io.to(peerId).emit('peer-left');
        if (peerCode) {
          SPEED_DIAL_CODES.set(peerCode, peerId);
        }
      }
      break;
    }
  }
}

io.on('connection', (socket) => {
  const code = generateCode();
  SPEED_DIAL_CODES.set(code, socket.id);
  SOCKET_CODES.set(socket.id, code);

  socket.emit('your-code', code);

  socket.on('pair', (targetCode) => {
    const targetSocketId = SPEED_DIAL_CODES.get(targetCode);
    if (!targetSocketId) {
      socket.emit('pair-error', 'Code not found or user disconnected');
      return;
    }
    if (targetSocketId === socket.id) {
      socket.emit('pair-error', 'You cannot pair with yourself');
      return;
    }

    if (PAIRED_ROOMS.has(socket.id) || PAIRED_ROOMS.has(targetSocketId)) {
      socket.emit('pair-error', 'One of the users is already in a chat');
      return;
    }

    for (const [, peers] of PAIRED_ROOMS) {
      if (peers.includes(socket.id) || peers.includes(targetSocketId)) {
        socket.emit('pair-error', 'One of the users is already in a chat');
        return;
      }
    }

    const roomName = [socket.id, targetSocketId].sort().join('-');

    socket.join(roomName);
    io.to(targetSocketId).socketsJoin(roomName);

    PAIRED_ROOMS.set(roomName, [socket.id, targetSocketId]);

    SPEED_DIAL_CODES.delete(code);
    SPEED_DIAL_CODES.delete(targetCode);

    socket.emit('paired', { peerCode: targetCode });
    io.to(targetSocketId).emit('paired', { peerCode: code });
  });

  socket.on('message', (data, ack) => {
    for (const [room, peers] of PAIRED_ROOMS) {
      if (peers.includes(socket.id)) {
        const peerId = peers.find(id => id !== socket.id);
        const msg = { text: data.text, time: Date.now() };
        io.to(peerId).emit('message', msg);
        if (typeof ack === 'function') ack(null, msg);
        return;
      }
    }
  });

  socket.on('file', (data) => {
    for (const [room, peers] of PAIRED_ROOMS) {
      if (peers.includes(socket.id)) {
        const peerId = peers.find(id => id !== socket.id);
        io.to(peerId).emit('file', {
          name: data.name,
          size: data.size,
          type: data.type,
          buffer: data.buffer,
          time: Date.now(),
        });
        return;
      }
    }
  });

  socket.on('typing', (isTyping) => {
    for (const [room, peers] of PAIRED_ROOMS) {
      if (peers.includes(socket.id)) {
        const peerId = peers.find(id => id !== socket.id);
        io.to(peerId).emit('typing', { isTyping });
        return;
      }
    }
  });

  socket.on('leave', () => {
    cleanupPairing(socket.id);
    socket.emit('left');
  });

  socket.on('disconnect', () => {
    cleanupPairing(socket.id);
    const userCode = SOCKET_CODES.get(socket.id);
    if (userCode) {
      SPEED_DIAL_CODES.delete(userCode);
      SOCKET_CODES.delete(socket.id);
    }
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
});
