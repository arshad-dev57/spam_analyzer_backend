// controllers/screenshot.controller.js
const cloudinary = require('../config/cloudinary');
const sharp = require('sharp');
const AnalyzedScreenshot = require('../models/analyzedScreenshot');
const streamifier = require('streamifier');

const isProd = process.env.VERCEL === '1' || process.env.NODE_ENV === 'production';

// ---------------- utils ----------------
const now = () => Date.now();
const ms = (t0) => `${Date.now() - t0}ms`;
const toKB = (b) => `${Math.round((b || 0) / 1024)}KB`;
const getDebugEnabled = (req) => {
  const q = (req.query?.debug ?? '').toString().toLowerCase();
  const h = (req.headers?.['x-debug'] ?? '').toString().toLowerCase();
  const b = (req.body?.debug ?? '').toString().toLowerCase();
  return q === '1' || h === '1' || b === '1';
};
function makeLogger(enabled, ns = 'API') {
  return {
    log: (...a) => enabled && console.log(`[${ns}]`, ...a),
    warn: (...a) => enabled && console.warn(`[${ns}]`, ...a),
    error: (...a) => enabled && console.error(`[${ns}]`, ...a),
  };
}

function streamUpload(buffer, folder) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder, resource_type: 'image' },
      (err, result) => (err ? reject(err) : resolve(result))
    );
    streamifier.createReadStream(buffer).pipe(stream);
  });
}

// --------------- compression -----------------
async function compressImageBuffer(inputBuffer, debug) {
  const { log } = debug.logger;
  const t0 = now();
  const targetSize = 100 * 1024;
  let quality = 80,
    width = 1000,
    best = inputBuffer;

  log(`compress: start size=${toKB(inputBuffer.byteLength)} target≈${toKB(targetSize)}`);
  while (width >= 200) {
    for (let q = quality; q >= 30; q -= 10) {
      const out = await sharp(inputBuffer)
        .resize({ width, withoutEnlargement: true })
        .jpeg({ quality: q, progressive: true, chromaSubsampling: '4:4:4' })
        .toBuffer();
      if (out.byteLength <= targetSize) {
        debug.data.compress = { width, quality: q, size: out.byteLength, took: ms(t0) };
        return out;
      }
      best = out;
    }
    width -= 100;
  }
  debug.data.compress = { width: 'fallback', quality: 'fallback', size: best.byteLength, took: ms(t0) };
  return best;
}

// --------------- controller ----------------
const uploadScreenshot = async (req, res) => {
  const debug = {
    enabled: getDebugEnabled(req),
    logger: makeLogger(getDebugEnabled(req), 'API'),
    data: { env: { isProd } }
  };

  try {
    // validate
    if (!req.user?.id) return res.status(401).json({ success: false, message: "Auth required" });
    if (!req.user?.email) return res.status(400).json({ success: false, message: "Email is required" });
    if (!req.user?.name) return res.status(400).json({ success: false, message: "Name is required" });
    if (!req.file?.buffer) return res.status(400).json({ success: false, message: "No file uploaded" });
    if (typeof req.body.isSpam === 'undefined') {
      return res.status(400).json({ success: false, message: "isSpam field required in body" });
    }

    debug.logger.log('request:', {
      user: { id: req.user.id, email: req.user.email, name: req.user.name },
      fileSize: toKB(req.file.buffer.byteLength),
      toNumber: req.body.toNumber,
      carrier: req.body.carrier,
      isSpam: req.body.isSpam,
    });

    const today = new Date().toISOString().split("T")[0];
    const folderName = `screenshots/${req.user.id}/${today}`;

    // 1) upload (compressed for storage)
    const compressedBuffer = await compressImageBuffer(req.file.buffer, debug);
    const tUp = now();
    const uploadResult = await streamUpload(compressedBuffer, folderName);
    debug.logger.log(`cloudinary upload ok in ${ms(tUp)} url=${uploadResult.secure_url}`);

    // 2) save to DB
    const doc = await AnalyzedScreenshot.create({
      user: req.user.id,
      name: req.user.name,
      email: req.user.email,
      imageUrl: uploadResult.secure_url,
      extractedNumber: req.body.extractedNumber || "Not Provided",
      time: new Date(),
      toNumber: req.body.toNumber || "error",
      carrier: req.body.carrier || "error",
      isSpam: req.body.isSpam,
    });

    // 3) response
    const payload = {
      success: true,
      data: {
        id: doc._id,
        user: doc.user,
        name: doc.name,
        email: doc.email,
        screenshotUrl: doc.imageUrl,
        extractedNumber: doc.extractedNumber,
        time: doc.time,
        toNumber: doc.toNumber,
        carrier: doc.carrier,
        isSpam: doc.isSpam,
      },
    };

    if (debug.enabled) {
      payload.debug = { ...debug.data };
    }

    return res.status(201).json(payload);
  } catch (err) {
    console.error("❌ Upload error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
};



const getAllAnalyzedScreenshots = async (req, res) => {
  try {
    const all = await AnalyzedScreenshot
      .find({ isDeleted: { $ne: true } })
      .sort({ time: -1 });

    res.status(200).json({
      success: true,
      count: all.length,
      data: all.map(item => ({
        screenshotUrl: item.imageUrl,
        extractedNumber: item.extractedNumber,
        id: item._id,
        time: item.time,
        toNumber: item.toNumber,
        carrier: item.carrier,
        isSpam: item.isSpam,
        isDeleted: !!item.isDeleted,
      })),
    });
  } catch (err) {
    console.error('❌ Fetch error:', err);
    res.status(500).json({ success: false, error: 'Server error' });
  }
};

const getallfilteredscreenshots = async (req, res) => {
  try {
    const userEmail = req.query.email || req.user.email;
    if (!userEmail) {
      return res.status(400).json({ success: false, error: 'Email is required' });
    }

    const all = await AnalyzedScreenshot
      .find({ email: userEmail, isDeleted: { $ne: true } })
      .sort({ time: -1 });

    res.status(200).json({
      success: true,
      count: all.length,
      data: all.map(item => ({
        user: item.user,
        email: item.email,
        screenshotUrl: item.imageUrl,
        extractedNumber: item.extractedNumber,
        id: item._id,
        time: item.time,
        toNumber: item.toNumber,
        carrier: item.carrier,
        isSpam: item.isSpam,
        isDeleted: !!item.isDeleted,
      })),
    });
  } catch (err) {
    console.error('❌ Fetch error:', err);
    res.status(500).json({ success: false, error: 'Server error' });
  }
};

const getallnamedfilterscreenshots = async (req, res) => {
  try {
    const userName = req.query.name || req.user.name;
    if (!userName) {
      return res.status(400).json({ success: false, error: 'Name is required' });
    }

    const all = await AnalyzedScreenshot
      .find({ name: userName, isDeleted: { $ne: true } })
      .sort({ time: -1 });

    res.status(200).json({
      success: true,
      count: all.length,
      data: all.map(item => ({
        user: item.user,
        name: item.name,
        email: item.email,
        screenshotUrl: item.imageUrl,
        extractedNumber: item.extractedNumber,
        id: item._id,
        time: item.time,
        toNumber: item.toNumber,
        carrier: item.carrier,
        isSpam: item.isSpam,
        isDeleted: !!item.isDeleted,
      })),
    });
  } catch (err) {
    console.error('❌ Fetch error:', err);
    res.status(500).json({ success: false, error: 'Server error' });
  }
};

const getlogginscreenshot = async (req, res) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ success: false, message: "Auth required" });
    }
    const page  = Math.max(parseInt(req.query.page || "1", 10), 1);
    const limit = Math.max(parseInt(req.query.limit || "20", 10), 1);
    const skip  = (page - 1) * limit;

    const filter = { user: req.user.id, isDeleted: { $ne: true } };

    const [items, total] = await Promise.all([
      AnalyzedScreenshot.find(filter)
        .sort({ time: -1, _id: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      AnalyzedScreenshot.countDocuments(filter),
    ]);

    return res.status(200).json({
      success: true,
      page,
      limit,
      total,
      data: items.map((item) => ({
        id: item._id,
        screenshotUrl: item.imageUrl,
        extractedNumber: item.extractedNumber,
        time: item.time,
        toNumber: item.toNumber,
        carrier: item.carrier,
        isSpam: item.isSpam,
        isDeleted: !!item.isDeleted,
      })),
    });
  } catch (err) {
    console.error("❌ Fetch error:", err);
    return res.status(500).json({ success: false, error: "Server error" });
  }
};

const softDeleteScreenshot = async (req, res) => {
  try {
    const { id } = req.params;
    const updated = await AnalyzedScreenshot.findByIdAndUpdate(
      id,
      { isDeleted: true, deletedAt: new Date() },
      { new: true }
    );
    if (!updated) {
      return res.status(404).json({ success: false, error: 'Screenshot not found' });
    }

    // 🔔 realtime
    emitScreenshotEvent(Events.DELETE_SOFT, { id, user: updated.user, email: updated.email });

    res.status(200).json({ success: true, message: 'Moved to Recently Deleted', data: updated });
  } catch (err) {
    console.error('❌ Soft delete error:', err);
    res.status(500).json({ success: false, error: 'Server error' });
  }
};

const getDeletedScreenshots = async (req, res) => {
  try {
    const deleted = await AnalyzedScreenshot.find({ isDeleted: true }).sort({ deletedAt: -1 });
    res.status(200).json({ success: true, count: deleted.length, data: deleted });
  } catch (err) {
    console.error('❌ Fetch deleted error:', err);
    res.status(500).json({ success: false, error: 'Server error' });
  }
};

const restoreScreenshot = async (req, res) => {
  try {
    const { id } = req.params;
    const updated = await AnalyzedScreenshot.findByIdAndUpdate(
      id,
      { isDeleted: false, deletedAt: null },
      { new: true }
    );
    if (!updated) return res.status(404).json({ success: false, error: 'Screenshot not found' });

    // 🔔 realtime
    emitScreenshotEvent(Events.UPDATE, updated);

    res.status(200).json({ success: true, message: 'Screenshot restored', data: updated });
  } catch (err) {
    console.error('❌ Restore error:', err);
    res.status(500).json({ success: false, error: 'Server error' });
  }
};

const permanentDeleteScreenshot = async (req, res) => {
  try {
    const { id } = req.params;
    const deleted = await AnalyzedScreenshot.findByIdAndDelete(id);
    if (!deleted) return res.status(404).json({ success: false, error: 'Screenshot not found' });

    // 🔔 realtime
    emitScreenshotEvent(Events.DELETE_PERM, { id, user: deleted.user, email: deleted.email });

    res.status(200).json({ success: true, message: 'Screenshot permanently deleted' });
  } catch (err) {
    console.error('❌ Permanent delete error:', err);
    res.status(500).json({ success: false, error: 'Server error' });
  }
};


 const getFlaggedNumbersStats = async (req, res) => {
  try {
    const match = {
      user: req.user.id,
      isDeleted: false,
    };

    if (req.query.from || req.query.to) {
      match.time = {};
      if (req.query.from) match.time.$gte = new Date(req.query.from);
      if (req.query.to) match.time.$lte = new Date(req.query.to);
    }

    if (req.query.carriers) {
      match.carrier = {
        $in: req.query.carriers.split(',').map(s => s.trim()),
      };
    }    const [result] = await AnalyzedScreenshot.aggregate([
      { $match: match },
      {
        $addFields: {
          carrier: { $ifNull: ['$carrier', 'Unknown'] },
        },
      },

      {
        $facet: {
          byCarrier: [
            {
              $group: {
                _id: '$carrier',
                total: { $sum: 1 },
                // analyzed: analyzedAt present? (in your schema it’s always set, still keep robust)
                analyzed: {
                  $sum: {
                    $cond: [{ $ifNull: ['$analyzedAt', false] }, 1, 0],
                  },
                },
                spam: { $sum: { $cond: ['$isSpam', 1, 0] } },
                clean: {
                  $sum: {
                    $cond: [{ $eq: ['$isSpam', false] }, 1, 0],
                  },
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
                errors: {
                  $max: [
                    0,
                    { $subtract: ['$analyzed', { $add: ['$clean', '$spam'] }] },
                  ],
                },
              },
            },
            { $sort: { total: -1 } },
          ],

          totals: [
            {
              $group: {
                _id: null,
                total: { $sum: 1 },
                analyzed: {
                  $sum: {
                    $cond: [{ $ifNull: ['$analyzedAt', false] }, 1, 0],
                  },
                },
                spam: { $sum: { $cond: ['$isSpam', 1, 0] } },
                clean: {
                  $sum: {
                    $cond: [{ $eq: ['$isSpam', false] }, 1, 0],
                  },
                },
              },
            },
            {
              $project: {
                _id: 0,
                total: 1,
                analyzed: 1,
                clean: 1,
                spam: 1,
                errors: {
                  $max: [
                    0,
                    { $subtract: ['$analyzed', { $add: ['$clean', '$spam'] }] },
                  ],
                },
              },
            },
          ],
        },
      },
      // ensure totals is an object not empty array
      {
        $project: {
          byCarrier: 1,
          totals: { $ifNull: [{ $arrayElemAt: ['$totals', 0] }, { total: 0, analyzed: 0, clean: 0, spam: 0, errors: 0 }] },
        },
      },
    ]);

    return res.json({ success: true, data: result });
  } catch (err) {
    console.error('❌ getFlaggedNumbersStats error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};
const  wipeAnalyzedScreenshots = async (req, res) => {
  try {
    const mode = (req.query.mode || 'soft').toLowerCase();
    const { confirm, userId, from, to } = req.query;

    const filter = {};
    if (userId && mongoose.isValidObjectId(userId)) {
      filter.user = new mongoose.Types.ObjectId(userId);
    }
    if (from || to) {
      filter.time = {};
      if (from) filter.time.$gte = new Date(from);
      if (to) filter.time.$lte = new Date(to);
    }

    if (mode === 'hard') {
      if (confirm !== 'YES') {
        return res.status(400).json({
          success: false,
          error:
            'Hard delete is destructive. Re-run with ?mode=hard&confirm=YES to proceed.',
        });
      }
      const { deletedCount } = await AnalyzedScreenshot.deleteMany(filter);
      return res.json({
        success: true,
        mode: 'hard',
        deletedCount,
      });
    }
    const result = await AnalyzedScreenshot.updateMany(
      filter,
      {
        $set: { isDeleted: true, deletedAt: new Date() },
      }
    );
    return res.json({
      success: true,
      mode: 'soft',
      matched: result.matchedCount ?? result.n,     
      modified: result.modifiedCount ?? result.nModified,
    });
  } catch (err) {
    console.error('❌ wipeAnalyzedScreenshots error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

const purgeAnalyzedScreenshots = async (req, res) => {
  try {
    const result = await AnalyzedScreenshot.deleteMany({}); // hard delete all docs
    return res.status(200).json({
      ok: true,
      message: "All analyzed screenshots deleted.",
      deletedCount: result.deletedCount,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, message: err.message });
  }
};

module.exports = {
  uploadScreenshot,
  getAllAnalyzedScreenshots,
  softDeleteScreenshot,
  getDeletedScreenshots,
  restoreScreenshot,
  permanentDeleteScreenshot,
  getlogginscreenshot,
  getallfilteredscreenshots,
  getallnamedfilterscreenshots,
  getFlaggedNumbersStats,
  wipeAnalyzedScreenshots,
  purgeAnalyzedScreenshots
};
