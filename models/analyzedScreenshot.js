// models/analyzedScreenshot.js

const mongoose = require('mongoose');

const analyzedScreenshotSchema = new mongoose.Schema({
  imageUrl: { type: String, required: true },
  extractedNumber: { type: String, required: true },
  analyzedAt: { type: Date, default: Date.now },
  time: { type: Date, required: true },
  toNumber: { type: String, required: true },
  carrier: { type: String, required: true },
  isSpam: { type: Boolean, default: false }, 
  isDeleted: { type: Boolean, default: false },
deletedAt: { type: Date, default: null },
});

module.exports = mongoose.model('AnalyzedScreenshot', analyzedScreenshotSchema);
