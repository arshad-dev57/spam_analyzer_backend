const mongoose = require('mongoose');

const KeywordSchema = new mongoose.Schema(
  {
    word: {
      type: String,
      required: true,
      trim: true,
    },

    norm: {
      type: String,
      required: true,
      index: true,
    },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

KeywordSchema.pre('validate', function (next) {
  if (typeof this.word === 'string') {
    const trimmed = this.word.trim();
    this.word = trimmed;
    this.norm = trimmed.toLowerCase();
  }
  next();
});

module.exports = mongoose.model('Keyword', KeywordSchema);
