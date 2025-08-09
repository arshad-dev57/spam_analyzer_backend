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
  res.send('🚀 API running');
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => console.log(`✅ Server running on port ${PORT}`));

