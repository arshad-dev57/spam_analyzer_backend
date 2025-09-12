
const {getFlaggedNumbersStatsAll}= require('../controllers/dashboard_controller');
const express = require('express');
const router = express.Router();

router.get('/getflaggednumbersstats', getFlaggedNumbersStatsAll);
module.exports = router;
