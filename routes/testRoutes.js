
const express = require('express');
const router = express.Router();
const { insertTest } = require('../controllers/testcontroller');

router.post('/', insertTest); // POST /api/test

module.exports = router;

