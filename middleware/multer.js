// middleware/multer.js
const multer = require('multer');

const storage = multer.memoryStorage(); // store file in memory

const upload = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024 } // 4MB limit, adjust if needed
});

module.exports = upload;
