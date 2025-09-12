// controllers/analyzedScreenshot.controller.js
// controllers/uploadScreenshot.js

const path = require('path');
const cloudinary = require('../config/cloudinary');
const tesseract = require('tesseract.js');
const sharp = require('sharp');
const AnalyzedScreenshot = require('../models/analyzedScreenshot');
const streamifier = require('streamifier');
const { getIO, Rooms, Events } = require('../config/socket');
const user = require('../models/user');
const isProd = process.env.VERCEL === '1' || process.env.NODE_ENV === 'production';
const OCR_TIMEOUT_MS = isProd ? 60_000 : 45_000;
const TESS_LANG_PATH = path.join(process.cwd(), 'public', 'tessdata');

// ---------------- utils ----------------
const clip = (s, n = 4000) => (s || '').toString().slice(0, n);
const now = () => Date.now();
const ms = (t0) => `${Date.now() - t0}ms`;
const toKB = (b) => `${Math.round((b || 0) / 1024)}KB`;
const getDebugEnabled = (req) => {
  const q = (req.query?.debug ?? '').toString().toLowerCase();
  const h = (req.headers?.['x-debug'] ?? '').toString().toLowerCase();
  const b = (req.body?.debug ?? '').toString().toLowerCase();
  return q === '1' || h === '1' || b === '1' || process.env.DEBUG_OCR === '1';
};
function makeLogger(enabled, ns = 'OCR') {
  return {
    log: (...a) => enabled && console.log(`[${ns}]`, ...a),
    warn: (...a) => enabled && console.warn(`[${ns}]`, ...a),
    error: (...a) => enabled && console.error(`[${ns}]`, ...a),
  };
}

// --------------- upload helper ---------------
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
  let quality = 80, width = 1000, best = inputBuffer;

  log(`compress: start size=${toKB(inputBuffer.byteLength)} target≈${toKB(targetSize)}`);
  while (width >= 200) {
    for (let q = quality; q >= 30; q -= 10) {
      const out = await sharp(inputBuffer)
        .resize({ width, withoutEnlargement: true })
        .jpeg({ quality: q, progressive: true, chromaSubsampling: '4:4:4' })
        .toBuffer();
      log(`compress try -> width=${width}, quality=${q}, size=${toKB(out.byteLength)}`);
      if (out.byteLength <= targetSize) {
        log(`compress: success in ${ms(t0)} -> ${toKB(out.byteLength)}`);
        debug.data.compress = { width, quality: q, size: out.byteLength, took: ms(t0) };
        return out;
      }
      best = out;
    }
    width -= 100;
  }
  log(`compress: fallback best size=${toKB(best.byteLength)} took=${ms(t0)}`);
  debug.data.compress = { width: 'fallback', quality: 'fallback', size: best.byteLength, took: ms(t0) };
  return best;
}

// --------------- preprocess ------------------
async function preprocessLight(buf, debug, tag) {
  const t0 = now();
  const out = await sharp(buf).grayscale().normalize().sharpen().toBuffer();
  debug.logger.log(`preprocess(${tag}): ${toKB(out.byteLength)} in ${ms(t0)}`);
  return out;
}
async function preprocessStrong(buf, debug, tag) {
  const t0 = now();
  const out = await sharp(buf)
    .grayscale()
    .normalize()
    .linear(1.2, -10)
    .threshold(160)
    .sharpen()
    .toBuffer();
  debug.logger.log(`preprocess(${tag}): ${toKB(out.byteLength)} in ${ms(t0)}`);
  return out;
}
async function cropTopHalf(buf, debug) {
  const img = sharp(buf);
  const meta = await img.metadata();
  const h = Math.round((meta.height || 0) * 0.5);
  const out = await img.extract({ left: 0, top: 0, width: meta.width, height: h }).toBuffer();
  debug.logger.log(`cropTopHalf: w=${meta.width} h=${meta.height} -> out=${toKB(out.byteLength)}`);
  debug.data.imageMeta = { width: meta.width, height: meta.height, format: meta.format };
  return out;
}

// --------------- timeout ---------------------
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error('OCR_TIMEOUT')), ms)),
  ]);
}

// --------------- normalize -------------------
function mapConfusablesToLatin(s) {
  const map = {
    a: /[\u0430\u03B1]/g, e: /[\u0435\u03B5]/g, i: /[\u0456\u03B9]/g,
    o: /[\u043E\u03BF]/g, p: /[\u0440\u03C1]/g, c: /[\u0441\u03C3\u03F2]/g,
    y: /[\u0443\u03C5]/g, x: /[\u0445\u03C7]/g, m: /[\u043C]/g,
    s: /[\u0455]/g, n: /[\u043D]/g, b: /[\u0432]/g, h: /[\u04BB]/g,
  };
  let out = s;
  for (const [lat, rx] of Object.entries(map)) out = out.replace(rx, lat);
  return out;
}
function normalizeForOCR(s) {
  return mapConfusablesToLatin(
    (s || '')
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '') // accents
      .replace(/rn/g, 'm')             // rn -> m (common OCR)
      .replace(/\$/g, 's')             // $ -> s
      // !! removed: .replace(/5/g, 's')
      .replace(/@/g, 'a')              // @ -> a
      // !! removed: .replace(/0/g, 'o')
      .replace(/[|!]/g, 'l')           // | and ! -> l
  ).replace(/[\W_]+/g, '');            // keep only [a-z0-9]
}


// --------------- fuzzy match -----------------
function lev(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(
        dp[i-1][j] + 1,
        dp[i][j-1] + 1,
        dp[i-1][j-1] + (a[i-1] === b[j-1] ? 0 : 1)
      );
    }
  }
  return dp[a.length][b.length];
}
function fuzzyContains(haystack, needle, maxDist = 2) {
  if (!haystack || !needle) return false;
  if (haystack.includes(needle)) return true;
  const n = needle.length;
  for (let i = 0; i <= haystack.length - n; i++) {
    if (lev(haystack.slice(i, i + n), needle) <= maxDist) return true;
  }
  return false;
}

function detectSpam(rawText, debug) {
  const raw = rawText || '';
  const norm = normalizeForOCR(raw);
  const letters = norm.replace(/[0-9]/g, ''); // remove digits entirely

  const reasons = [];

  // Exact banner phrases on RAW text (most reliable)
  const rawExact = [
    /\bSuspected\s*Spam\b/i,
    /\bSpam\s*Risk\b/i,
    /\bScam\s*Likely\b/i,
    /\bFraud\s*Risk\b/i,
    /\bSpam\b/i // standalone "Spam" (e.g., big header)
  ];
  if (rawExact.some(rx => rx.test(raw))) {
    reasons.push('raw-exact');
  }

  // Spaced letters like "S p a m"
  if (/\bs\s*p\s*a\s*m\b/i.test(raw)) reasons.push('raw-spaced');

  // Strong tokens must appear (fuzzy <=1) on letters-only string
  const strong = ['spam', 'scam', 'fraud', 'suspected'];
  const hasStrong = strong.some(w => fuzzyContains(letters, w, 1));
  if (hasStrong) reasons.push('letters-strong');

  // Phrase combos allowed (fuzzy <=2) on letters-only
  const phrases = ['suspectedspam', 'spamrisk', 'scamlikely', 'fraudrisk'];
  const hasPhrase = phrases.some(p => fuzzyContains(letters, p, 2));
  if (hasPhrase) reasons.push('letters-phrase');

  // IMPORTANT: "risk" / "likely" alone should NOT trigger
  // (pehle yahin se false positives aa rahe the)
  // Agar sirf risk/likely milta hai bina strong/phrase ke, ignore:
  const weak = ['risk', 'likely'];
  const hasOnlyWeak =
    !hasStrong && !hasPhrase &&
    weak.some(w => fuzzyContains(letters, w, 1));
  if (hasOnlyWeak) {
    // don't add reason; explicitly ignore weak-only
  }

  const isSpam = reasons.length > 0;

  if (debug?.enabled) {
    debug.logger.log('detectSpam:', {
      isSpam,
      reasons,
      lettersOnly: letters.slice(0, 300)
    });
  }

  return { isSpam, reasons, norm };
}

// --------------- OCR attempt ----------------
async function runOCRAttempt(buf, psm, tag, debug) {
  const t0 = now();
  try {
    const res = await withTimeout(
      tesseract.recognize(buf, 'eng', {
        langPath: TESS_LANG_PATH,
        tessedit_pageseg_mode: String(psm),
        preserve_interword_spaces: '1',
      }),
      OCR_TIMEOUT_MS
    );
    const text = (res.data.text || '').trim();
    const attempt = {
      tag, psm, len: text.length, took: ms(t0),
      sample: clip(text, 300),
      normSample: clip(normalizeForOCR(text), 300),
    };
    debug.data.ocrAttempts.push(attempt);
    debug.logger.log(`runOCRAttempt OK tag=${tag} psm=${psm} len=${text.length} took=${attempt.took}`);
    return text;
  } catch (e) {
    const attempt = { tag, psm, error: e.message, took: ms(t0) };
    debug.data.ocrAttempts.push(attempt);
    debug.logger.warn(`runOCRAttempt FAIL tag=${tag} psm=${psm} in ${attempt.took}: ${e.message}`);
    return '';
  }
}

// --------------- OCR orchestrator ----------
async function runOCRAll(originalBuf, debug) {
  const { log } = debug.logger;

  // build variants (FIX: strongTop defined correctly)
  const topBuf = await cropTopHalf(originalBuf, debug);
  const strongTop = await preprocessStrong(topBuf, debug, 'strong-top');
  const lightTop  = await preprocessLight(topBuf,  debug, 'light-top');
  const strongFull = await preprocessStrong(originalBuf, debug, 'strong-full');
  const lightFull  = await preprocessLight(originalBuf,  debug, 'light-full');

  const variants = [
    { buf: strongTop,  tag: 'strong-top' },
    { buf: lightTop,   tag: 'light-top' },
    { buf: strongFull, tag: 'strong-full' },
    { buf: lightFull,  tag: 'light-full' },
  ];
  const psms = [11, 6, 7, 3];

  let best = { text: '', reason: 'none' };

  for (const v of variants) {
    for (const p of psms) {
      const text = await runOCRAttempt(v.buf, p, v.tag, debug);
      if (!text) continue;

      // early exit if banner words found
      const probe = detectSpam(text, debug);
      if (probe.isSpam) {
        debug.logger.log(`OCR early-hit spam on tag=${v.tag} psm=${p}`);
        debug.data.ocrChosen = { tag: v.tag, psm: p, reason: 'contains-spam' };
        return text;
      }

      if (text.length > best.text.length) {
        best = { text, reason: `longest(tag=${v.tag}, psm=${p})` };
      }
    }
  }

  debug.logger.log(`OCR choose best=${best.reason} len=${best.text.length}`);
  debug.data.ocrChosen = { reason: best.reason, len: best.text.length };
  return best.text;
}

// --------------- phone extract -------------
function extractPhone(text, debug) {
  const rx = /\+?[0-9][0-9\s\-()]{7,}/g;
  const all = text?.match(rx) || [];
  const first = all[0] ? all[0].replace(/\s+/g, ' ').trim() : 'Not Found';
  debug.logger.log('extractPhone:', { all: all.slice(0, 5), first });
  return first;
}

// --------------- controller ----------------
const uploadScreenshot = async (req, res) => {
  const debug = {
    enabled: getDebugEnabled(req),
    logger: makeLogger(getDebugEnabled(req), 'OCR'),
    data: { env: { isProd, langPath: TESS_LANG_PATH, timeoutMs: OCR_TIMEOUT_MS }, ocrAttempts: [] }
  };

  try {
    // validate
    if (!req.user?.id)   return res.status(401).json({ success: false, message: "Auth required" });
    if (!req.user?.email) return res.status(400).json({ success: false, message: "Email is required" });
    if (!req.user?.name)  return res.status(400).json({ success: false, message: "Name is required" });
    if (!req.file?.buffer) return res.status(400).json({ success: false, message: "No file uploaded" });

    debug.logger.log('request:', {
      user: { id: req.user.id, email: req.user.email, name: req.user.name },
      fileSize: toKB(req.file.buffer.byteLength),
      toNumber: req.body.toNumber, carrier: req.body.carrier,
    });

    const today = new Date().toISOString().split("T")[0];
    const folderName = `screenshots/${req.user.id}/${today}`;

    // 1) upload (compressed for storage)
    const compressedBuffer = await compressImageBuffer(req.file.buffer, debug);
    const tUp = now();
    const uploadResult = await streamUpload(compressedBuffer, folderName);
    debug.logger.log(`cloudinary upload ok in ${ms(tUp)} url=${uploadResult.secure_url}`);

    // 2) OCR (always ORIGINAL first)
    let text = "", ocrErrors = [];
    try {
      const tOcr = now();
      text = await runOCRAll(req.file.buffer, debug);
      if (!text) {
        debug.logger.warn('primary OCR empty -> retry on compressed');
        text = await runOCRAll(compressedBuffer, debug);
      }
      debug.logger.log(`OCR total took=${ms(tOcr)} finalLen=${text.length}`);
    } catch (e) {
      debug.logger.error('OCR fatal:', e.message);
      ocrErrors.push(e.message);
    }

    // print blocks even if empty (so tumhe console me visible ho)
    if (debug.enabled) {
      console.log('--- RAW_OCR_START ---\n' + (text || '[EMPTY]') + '\n--- RAW_OCR_END ---');
      console.log('--- NORMALIZED ---\n' + (normalizeForOCR(text) || '[EMPTY]'));
    }

    // 3) spam verdict
    const verdict = detectSpam(text, debug);

    // 4) phone
    const extracted = extractPhone(text, debug);

    // 5) save
    const doc = await AnalyzedScreenshot.create({
      user: req.user.id,
      name: req.user.name,
      email: req.user.email,
      imageUrl: uploadResult.secure_url,
      extractedNumber: extracted,
      time: new Date(),
      toNumber: req.body.toNumber || "Unknown",
      carrier: req.body.carrier || "Unknown",
      isSpam: verdict.isSpam,
      // OPTIONAL: add these fields in schema before uncommenting
      // ocrText: clip(text, 10000),
      // normalizedText: clip(verdict.norm, 10000),
      // debugReasons: verdict.reasons,
    });

    // 6) response
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

    if (debug.enabled) {
      payload.debug = {
        ...debug.data,
        rawOCR: clip(text, 2000),
        normalized: clip(verdict.norm, 2000),
        spamReasons: verdict.reasons,
        ocrChosen: debug.data.ocrChosen || null,
        compress: debug.data.compress || null,
        ocrErrors,
      };
    }

    return res.status(201).json(payload);
  } catch (err) {
    console.error("❌ Upload error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

module.exports = { uploadScreenshot };



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

    // Build filter (default: all docs)
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
  wipeAnalyzedScreenshots
};
