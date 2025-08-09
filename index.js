// api/index.js
const express = require('express');
const dotenv = require('dotenv');
const cors = require('cors');
const connectDB = require('./config/db');

// Load env
dotenv.config();

const app = express();

// CORS
app.use(cors());

// Body parser
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Health Check
app.get('/', (req, res) => {
  res.send('🚀 Spam Analyzer backend is running!');
});

// Routes
app.use('/api/test', require('../routes/testRoutes'));
app.use('/api/screenshot', require('../routes/screenshot_routes'));

// Connect to DB (only once in serverless)
(async () => {
  await connectDB();
})();

// Export for Vercel
module.exports = (req, res) => {
  return app(req, res);
};
