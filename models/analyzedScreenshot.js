// models/analyzedScreenshot.js
const mongoose = require('mongoose');

const analyzedScreenshotSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },

    imageUrl: { type: String, required: true },
    extractedNumber: { type: String, required: true },
    analyzedAt: { type: Date, default: Date.now },
    time: { type: Date, required: true },
    toNumber: { type: String, required: true, default: 'Unknown' },
    carrier: { type: String, required: true, default: 'Unknown' },
    isSpam: { type: Boolean, default: false },
    isDeleted: { type: Boolean, default: false, index: true },
    deletedAt: { type: Date, default: null },
  },
  { versionKey: false }
);
analyzedScreenshotSchema.index({ user: 1, isDeleted: 1, time: -1 });
module.exports = mongoose.model('AnalyzedScreenshot', analyzedScreenshotSchema);
