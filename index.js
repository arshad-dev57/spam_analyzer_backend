// index.js (root) — WS enabled (non-Vercel), HTTP-only (Vercel)
const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const http = require('http');                 // 🔸 for socket.io
const connectDB = require('./config/db');
const { initSocket } = require('./config/socket');  // 🔔 our socket bootstrap

// Load env only in local/dev
if (process.env.NODE_ENV !== 'production') {
  dotenv.config();
}

const app = express();

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

app.get('/', (req, res) => {
  res.send('🚀 Spam Analyzer backend is running!');
});

// Routes
app.use('/api/test', require('./routes/testRoutes'));
app.use('/api/screenshot', require('./routes/screenshot_routes'));
app.use('/api/user', require('./routes/auth_routes'));
app.use('/api', require('./routes/ping_routes'));

// DB connect (don’t block server start)
(async () => {
  try { await connectDB(); }
  catch (e) { console.error('DB connect error at boot:', e?.message); }
})();

/**
 * ──────────────────────────────────────────────────────────────────────────────
 *  VERCEL / serverless: export handler (no WebSockets)
 *  Non-Vercel (local / Render / VPS): create HTTP server + init Socket.IO
 * ──────────────────────────────────────────────────────────────────────────────
 */

// Export for Vercel (HTTP-only, no WS on serverless)
module.exports = (req, res) => app(req, res);

// Start server locally / on long-lived hosts (Render, VPS, etc.)
if (require.main === module && !process.env.VERCEL) {
  const PORT = process.env.PORT || 5000;

  // 🔸 Create HTTP server & attach Socket.IO
  const server = http.createServer(app);

  // Allow overriding CORS origins via env (comma-separated)
  const corsOrigins = (process.env.SOCKET_CORS_ORIGINS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  initSocket(server, {
    corsOrigins: corsOrigins.length
      ? corsOrigins
      : [
          'http://localhost:5173',   // Vite / React
          'http://localhost:3000',   // Next/CRA
          'http://localhost:8081',   // Flutter web
          'https://your-cms-domain.com'
        ],
  });

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ HTTP+WS server running at http://localhost:${PORT}`);

    // Optional keep-alive ping for Render / free tiers
    const axios = require('axios');
    setInterval(async () => {
      try {
        await axios.get('https://spam-analyzer-backend.onrender.com/api/ping');
        console.log(`[AutoPing] Successful at ${new Date().toISOString()}`);
      } catch (err) {
        console.error('[AutoPing] Failed:', err.message);
      }
    }, 15 * 60 * 1000); // 15 minutes
  });
}

/*  ────────────────────────────────────────────────────────────────────────────
    NOTE (proxy/nginx):
      proxy_set_header Upgrade $http_upgrade;
      proxy_set_header Connection "upgrade";
    Client connect example:
      io(API_BASE, { auth: { role: 'admin', userId, email }, transports: ['websocket'] })
    Events emitted by controllers:
      'screenshots:new', 'screenshots:update', 'screenshots:delete:soft', 'screenshots:delete:permanent'
    ────────────────────────────────────────────────────────────────────────────
*/
