// controllers/analyzedScreenshot.controller.js
const path = require('path');
const cloudinary = require('../config/cloudinary');
const tesseract = require('tesseract.js');
const sharp = require('sharp');
const AnalyzedScreenshot = require('../models/analyzedScreenshot');
const streamifier = require('streamifier');

// 🔔 Realtime
const { getIO, Rooms, Events } = require('../config/socket');

const isProd = process.env.VERCEL === '1' || process.env.NODE_ENV === 'production';
const OCR_TIMEOUT_MS = isProd ? 45_000 : 30_000;

const TESS_LANG_PATH = path.join(process.cwd(), 'public', 'tessdata');

function streamUpload(buffer, folder) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder, resource_type: 'image' },
      (err, result) => (err ? reject(err) : resolve(result))
    );
    streamifier.createReadStream(buffer).pipe(stream);
  });
}

async function compressImageBuffer(inputBuffer) {
  const targetSize = 100 * 1024; // ~100KB
  let quality = 80, width = 1000, best = inputBuffer;

  while (width >= 200) {
    for (let q = quality; q >= 30; q -= 10) {
      const out = await sharp(inputBuffer)
        .resize({ width, withoutEnlargement: true })
        .jpeg({ quality: q, progressive: true, chromaSubsampling: '4:4:4' })
        .toBuffer();
      if (out.byteLength <= targetSize) return out;
      best = out;
    }
    width -= 100;
  }
  return best;
}

// ==== Promise timeout helper ====
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error('OCR_TIMEOUT')), ms)),
  ]);
}

// ==== Confusable → Latin mapping ====
function mapConfusablesToLatin(s) {
  const map = {
    a: /[\u0430\u03B1]/g,
    e: /[\u0435\u03B5]/g,
    i: /[\u0456\u03B9]/g,
    o: /[\u043E\u03BF]/g,
    p: /[\u0440\u03C1]/g,
    c: /[\u0441\u03C3\u03F2]/g,
    y: /[\u0443\u03C5]/g,
    x: /[\u0445\u03C7]/g,
    m: /[\u043C]/g,
    s: /[\u0455]/g,
    n: /[\u043D]/g,
    b: /[\u0432]/g,
    h: /[\u04BB]/g,
  };
  let out = s;
  for (const [lat, rx] of Object.entries(map)) out = out.replace(rx, lat);
  return out;
}

function normalizeForOCR(s) {
  return mapConfusablesToLatin(
    s
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/rn/g, 'm')
      .replace(/\$/g, 's')
      .replace(/5/g, 's')
      .replace(/@/g, 'a')
      .replace(/0/g, 'o')
      .replace(/[|!]/g, 'l')
  ).replace(/[\W_]+/g, '');
}

function hasSpam(rawText) {
  if (!rawText) return false;
  if (/\bspam\b/i.test(rawText)) return true;
  if (/\bs\s*p\s*a\s*m\b/i.test(rawText)) return true;
  if (/\b[s\$5]\s*[pP]\s*[a@]\s*[mMnRN]\b/.test(rawText)) return true;

  const norm = normalizeForOCR(rawText);
  if (norm.includes('spam')) return true;

  const alt = ['scam', 'junk', 'fraud'];
  if (new RegExp(`\\b(${alt.join('|')})\\b`, 'i').test(rawText)) return true;
  if (new RegExp(`(${alt.join('|')})`).test(norm)) return true;

  return false;
}

async function runOCR(buf, psm = 6) {
  const ocrInput = await sharp(buf).grayscale().normalize().toBuffer();
  const t0 = Date.now();
  const ocrRes = await withTimeout(
    tesseract.recognize(ocrInput, 'eng', {
      langPath: TESS_LANG_PATH,
      tessedit_pageseg_mode: String(psm),
      preserve_interword_spaces: '1',
    }),
    OCR_TIMEOUT_MS
  );
  const text = (ocrRes.data.text || '').trim();
  console.log(`[OCR] PSM=${psm} len=${text.length} took=${Date.now()-t0}ms`);
  return text;
}

/** 🔔 common payload shaper (what CMS needs) */
function shape(item) {
  return {
    id: item._id,
    user: item.user,
    name: item.name,
    email: item.email,
    screenshotUrl: item.imageUrl,
    extractedNumber: item.extractedNumber,
    time: item.time,
    toNumber: item.toNumber,
    carrier: item.carrier,
    isSpam: item.isSpam,
    isDeleted: !!item.isDeleted,
  };
}

/** 🔔 broadcast helper */
function emitScreenshotEvent(kind, docOrObj) {
  try {
    const io = getIO();
    const data = docOrObj._id ? shape(docOrObj) : docOrObj;

    // global (all listeners)
    io.to(Rooms.all).emit(kind, data);
    // per-user & per-email channels for targeted UIs
    if (data.user) io.to(Rooms.user(String(data.user))).emit(kind, data);
    if (data.email) io.to(Rooms.email(String(data.email))).emit(kind, data);
    // admins dashboard
    io.to(Rooms.admins).emit(kind, data);
  } catch (e) {
    // If socket not initialized (e.g., serverless), don't crash the request
    console.warn('WS emit skipped:', e.message);
  }
}

const uploadScreenshot = async (req, res) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ success: false, message: "Auth required" });
    }
    if (!req.user?.email) {
      return res.status(400).json({ success: false, message: "Email is required" });
    }
    if (!req.user?.name) {
      return res.status(400).json({ success: false, message: "Name is required" });
    }
    if (!req.file?.buffer) {
      return res.status(400).json({ success: false, message: "No file uploaded" });
    }

    const today = new Date().toISOString().split("T")[0];
    const folderName = `screenshots/${req.user.id}/${today}`;

    const compressedBuffer = await compressImageBuffer(req.file.buffer);
    const uploadResult = await streamUpload(compressedBuffer, folderName);

    let text = "";
    let ocrErrors = [];
    try {
      text = await runOCR(req.file.buffer, 6);
      if (!text) text = await runOCR(compressedBuffer, 6);
      if (!text) text = await runOCR(req.file.buffer, 7);
      if (!text) text = await runOCR(req.file.buffer, 3);
    } catch (e) {
      console.warn("OCR issue:", e.message);
      ocrErrors.push(e.message);
    }

    const containsSpam = hasSpam(text);

    const matches = text?.match(/\+?[0-9][0-9\s\-()]{7,}/g);
    const extracted = matches?.[0]?.replace(/\s+/g, " ").trim() || "Not Found";

    const doc = await AnalyzedScreenshot.create({
      user: req.user.id,
      name: req.user.name,
      email: req.user.email,
      imageUrl: uploadResult.secure_url,
      extractedNumber: extracted,
      time: new Date(),
      toNumber: req.body.toNumber || "Unknown",
      carrier: req.body.carrier || "Unknown",
      isSpam: containsSpam,
    });

    const payload = {
      success: true,
      data: {
        id: doc._id,
        user: doc.user,
        name: doc.name,
        email: doc.email,
        screenshotUrl: uploadResult.secure_url,
        extractedNumber: extracted,
        time: doc.time,
        toNumber: doc.toNumber,
        carrier: doc.carrier,
        isSpam: doc.isSpam,
      },
    };

    // 🔔 realtime push (no refresh)
    emitScreenshotEvent(Events.NEW, doc);

    if (req.query.debug === "1") {
      payload.data.rawOCR = text;
      payload.data.normalized = normalizeForOCR(text);
      payload.data.env = { isProd, langPath: TESS_LANG_PATH, timeoutMs: OCR_TIMEOUT_MS };
      if (ocrErrors.length) payload.data.ocrErrors = ocrErrors;
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

module.exports = {
  uploadScreenshot,
  getAllAnalyzedScreenshots,
  softDeleteScreenshot,
  getDeletedScreenshots,
  restoreScreenshot,
  permanentDeleteScreenshot,
  getlogginscreenshot,
  getallfilteredscreenshots,
  getallnamedfilterscreenshots
};
