// api/index.js
const express = require('express');
const dotenv = require('dotenv');
const connectDB = require('../config/db');

dotenv.config();

const app = express();
app.use(express.json());

app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

app.use('/api/test', require('../routes/testRoutes'));
app.use('/api/screenshot', require('../routes/screenshot_routes'));

module.exports = async (req, res) => {
  await connectDB();
  return app(req, res);
};
