// Ping Route
const express = require('express');
const router = express.Router();
const { ping } = require('../controllers/ping_controller');
router.get('/ping', ping);
module.exports = router;