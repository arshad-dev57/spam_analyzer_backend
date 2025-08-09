const express = require('express');
const dotenv = require('dotenv');
const connectDB = require('./config/db');
const upload = require('./middleware/multer');

dotenv.config();
connectDB();

const app = express();

app.use(express.json());

app.use('/api/test', require('./routes/testRoutes'));
app.use('/api/screenshot', require('./routes/screenshot_routes'));

app.get('/', (req, res) => {
  res.send('🚀 API running');// api/index.js
  const express = require('express');
  const dotenv = require('dotenv');
  const connectDB = require('../config/db');
  
  dotenv.config();
  
  const app = express();
  app.use(express.json());
  
  // health check
  app.get('/api/health', (req, res) => res.json({ ok: true }));
  
  // routes
  app.use('/api/test', require('../routes/testRoutes'));
  app.use('/api/screenshot', require('../routes/screenshot_routes'));
  
  // serverless handler (NO app.listen)
  module.exports = async (req, res) => {
    await connectDB();
    return app(req, res);
  };
  
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => console.log(`✅ Server running on port ${PORT}`));

