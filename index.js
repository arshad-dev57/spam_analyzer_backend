// index.js (root)
const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const connectDB = require('./config/db');

// Load env locally (Vercel par vars dashboard se aate hain)
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

// Routes (index.js root me hai isliye ./routes/...)
app.use('/api/test', require('./routes/testRoutes'));
app.use('/api/screenshot', require('./routes/screenshot_routes'));

// DB connect once
(async () => {
  try {
    await connectDB();
  } catch (e) {
    console.error('DB connect error at boot:', e?.message);
  }
})();

// --- Vercel handler export ---
module.exports = (req, res) => app(req, res);

// --- Local server start (only when run directly) ---
if (require.main === module && !process.env.VERCEL) {
  const PORT = process.env.PORT || 5000;
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Local server running at http://localhost:${PORT}`);
  });
}
