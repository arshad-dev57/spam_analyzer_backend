// controllers/analyzedStats.controller.js
const mongoose = require('mongoose');
const AnalyzedScreenshot = require('../models/analyzedScreenshot');
const getFlaggedNumbersStatsAll = async (req, res) => {
  try {
    // => sirf optional filters; by default poori collection
    const { from, to, carriers } = req.query;

    const match = { isDeleted: false }; // soft-deleted ignore

    if (from || to) {
      match.time = {};
      if (from) match.time.$gte = new Date(from);
      if (to) match.time.$lte = new Date(to);
    }
    if (carriers) {
      match.carrier = String(carriers)
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
    }

    const [out] = await AnalyzedScreenshot.aggregate([
      { $match: match },

      // normalize fields
      {
        $addFields: {
          carrier: { $ifNull: ['$carrier', 'Unknown'] },
          // isSpam could be null/undefined in old docs
          isSpam: { $ifNull: ['$isSpam', null] },
        },
      },

      {
        $facet: {
          byCarrier: [
            {
              $group: {
                _id: '$carrier',
                total: { $sum: 1 },
                analyzed: {
                  $sum: { $cond: [{ $ifNull: ['$analyzedAt', false] }, 1, 0] },
                },
                spam: { $sum: { $cond: [{ $eq: ['$isSpam', true] }, 1, 0] } },
                clean: { $sum: { $cond: [{ $eq: ['$isSpam', false] }, 1, 0] } },
              },
            },
            {
              $addFields: {
                errors: {
                  $max: [
                    0,
                    { $subtract: ['$analyzed', { $add: ['$clean', '$spam'] }] },
                  ],
                },
              },
            },
            {
              $project: {
                _id: 0,
                carrier: '$_id',
                total: 1,
                analyzed: 1,
                clean: 1,
                spam: 1,
                errors: 1,
              },
            },
            { $sort: { total: -1, carrier: 1 } },
          ],

          totals: [
            {
              $group: {
                _id: null,
                total: { $sum: 1 },
                analyzed: {
                  $sum: { $cond: [{ $ifNull: ['$analyzedAt', false] }, 1, 0] },
                },
                spam: { $sum: { $cond: [{ $eq: ['$isSpam', true] }, 1, 0] } },
                clean: { $sum: { $cond: [{ $eq: ['$isSpam', false] }, 1, 0] } },
              },
            },
            {
              $addFields: {
                errors: {
                  $max: [
                    0,
                    { $subtract: ['$analyzed', { $add: ['$clean', '$spam'] }] },
                  ],
                },
              },
            },
            { $project: { _id: 0, total: 1, analyzed: 1, clean: 1, spam: 1, errors: 1 } },
          ],
        },
      },

      {
        $project: {
          byCarrier: 1,
          totals: {
            $ifNull: [
              { $arrayElemAt: ['$totals', 0] },
              { total: 0, analyzed: 0, clean: 0, spam: 0, errors: 0 },
            ],
          },
        },
      },
    ]);

    return res.json({ success: true, data: out });
  } catch (e) {
    console.error('❌ getFlaggedNumbersStatsAll error:', e);
    return res.status(500).json({ success: false, error: e.message });
  }
};


module.exports = {
    getFlaggedNumbersStatsAll,
};