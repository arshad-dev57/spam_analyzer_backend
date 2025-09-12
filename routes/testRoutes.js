
const express = require('express');
const router = express.Router();
const { insertTest } = require('../controllers/testcontroller');

router.post('/', insertTest); 

module.exports = router;

