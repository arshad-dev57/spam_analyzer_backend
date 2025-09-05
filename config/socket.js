// config/socket.js
const { Server } = require('socket.io');

let io;

const Rooms = {
  admins: 'admins',
  all: 'all',
  user: (id) => `user:${id}`,
  email: (email) => `email:${email}`,
};

const Events = {
  NEW: 'screenshots:new',
  UPDATE: 'screenshots:update',
  DELETE_SOFT: 'screenshots:delete:soft',
  DELETE_PERM: 'screenshots:delete:permanent',
};

function initSocket(server, opts = {}) {
  io = new Server(server, {
    cors: {
      origin: opts.corsOrigins || ['http://localhost:5173', 'http://localhost:3000'],
      credentials: false,
    },
    transports: ['websocket'],
  });

  io.on('connection', (socket) => {
    const { role, userId, email } = socket.handshake.auth || {};
    if (role === 'admin') socket.join(Rooms.admins);
    if (userId) socket.join(Rooms.user(userId));
    if (email) socket.join(Rooms.email(email));
    socket.join(Rooms.all);

    socket.emit('ready', { ok: true });
  });

  return io;
}

function getIO() {
  if (!io) throw new Error('Socket.io not initialized');
  return io;
}

module.exports = { initSocket, getIO, Rooms, Events };
