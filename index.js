// index.js  (root)
const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const connectDB = require('./config/db');

// load env (local dev ke liye; Vercel par vars dashboard se aayenge)
if (process.env.NODE_ENV !== 'production') {
  dotenv.config();
}

const app = express();

// CORS
app.use(cors());

// Body parser
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Health
app.get('/', (req, res) => {
  res.send('🚀 Spam Analyzer backend is running!');
});

// ✅ Correct paths (because index.js is at root)
app.use('/api/test', require('./routes/testRoutes'));
app.use('/api/screenshot', require('./routes/screenshot_routes'));

// Connect DB once (serverless safe)
(async () => {
  try {
    await connectDB();
  } catch (e) {
    // runtime logs me clear error dikh jayega
    console.error('DB connect error at boot:', e?.message);
  }
})();

// Export for Vercel (no app.listen)
module.exports = (req, res) => app(req, res);
