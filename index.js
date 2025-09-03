// index.js (root)
const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const connectDB = require('./config/db');

// Load env only in local/dev
if (process.env.NODE_ENV !== 'production') {
  dotenv.config();
}

const app = express();

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Health
app.get('/', (req, res) => {
  res.send('🚀 Spam Analyzer backend is running!');
});

// Routes
app.use('/api/test', require('./routes/testRoutes'));
app.use('/api/screenshot', require('./routes/screenshot_routes'));
app.use('/api/user', require('./routes/auth_routes'));
app.use('/api', require('./routes/ping_routes'));
(async () => {
  try { await connectDB(); }
  catch (e) { console.error('DB connect error at boot:', e?.message); }
})();

// Export for Vercel
module.exports = (req, res) => app(req, res);

// Start server locally (when run via `node index.js` / nodemon)
if (require.main === module && !process.env.VERCEL) {
  const PORT = process.env.PORT || 5000;
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Local server running at http://localhost:${PORT}`);
    const axios = require('axios');
    setInterval(async () => {
        try {
            await axios.get('https://spam-analyzer-backend.onrender.com/api/ping');
            console.log(`[AutoPing] Successful at ${new Date().toISOString()}`);
        } catch (err) {
            console.error('[AutoPing] Failed:', err.message);
        }
    }, 15 * 60 * 1000); // 10 minutes
    ///////////////////////////
  });
}
