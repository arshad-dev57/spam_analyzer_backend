// controllers/analyzedScreenshot.controller.js
// controllers/uploadScreenshot.js
const path = require('path');
const cloudinary = require('../config/cloudinary');
const sharp = require('sharp');
const AnalyzedScreenshot = require('../models/analyzedScreenshot');
const streamifier = require('streamifier');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const { getIO, Rooms, Events } = require('../config/socket');
const Keyword = require('../models/keyword_model'); // <-- your Keyword model
const isProd = process.env.VERCEL === '1' || process.env.NODE_ENV === 'production';
const GEMINI_TIMEOUT_MS = isProd ? 45_000 : 25_000; // increased timeout

// Concurrency throttle for free tier safety
let _pending = 0;
const MAX_CONCURRENT = isProd ? 2 : 3;
async function withQueue(fn) {
  while (_pending >= MAX_CONCURRENT) {
    await new Promise(r => setTimeout(r, 150));
  }
  _pending++;
  try { return await fn(); }
  finally { _pending--; }
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

async function compressImageBuffer(inputBuffer) {
  const targetSize = 100 * 1024;
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
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error('GENAI_TIMEOUT')), ms)),
  ]);
}

// ====== Text normalization helpers ======
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
    s.toLowerCase()
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

// ====== Legacy 'Spam' detector (fallback) ======
function hasSpam(rawText) {
  if (!rawText) return false;
  if (/\bSpam\b/.test(rawText)) return true;
  if (/\bS\W*p\W*a\W*m\b/.test(rawText)) return true;
  if (/\bS\W*p\W*a\W*(?:m|rn|Rn|rN|RN)\b/.test(rawText)) return true;

  const normalizedCase = mapConfusablesToLatin(
    rawText.normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/rn/g, 'm')
      .replace(/\$/g, 's')
      .replace(/5/g, 's')
      .replace(/@/g, 'a')
      .replace(/0/g, 'o')
      .replace(/[|!]/g, 'l')
  ).replace(/[\W_]+/g, '');

  if (normalizedCase.includes('Spam')) return true;

  const alt = ['scam', 'junk', 'fraud'];
  if (new RegExp(`\\b(${alt.join('|')})\\b`, 'i').test(rawText)) return true;

  const normLower = normalizeForOCR(rawText);
  if (new RegExp(`(${alt.join('|')})`).test(normLower)) return true;

  return false;
}

// ====== Gemini client ======
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// low-level OCR call
async function runGeminiExtractText(buf, mime = 'image/jpeg', {
  modelName = 'gemini-1.5-flash',
  timeoutMs = GEMINI_TIMEOUT_MS,
} = {}) {
  const model = genAI.getGenerativeModel({
    model: modelName,
    generationConfig: { responseMimeType: 'text/plain' },
  });

  const prompt =
    'Extract ALL visible text from this image as plain text. ' +
    'Preserve original casing and characters exactly. ' +
    'Do NOT summarize or translate. Return ONLY the raw text.';

  const imagePart = { inlineData: { data: buf.toString('base64'), mimeType: mime } };

  const res = await withTimeout(
    model.generateContent([{ text: prompt }, imagePart]),
    timeoutMs
  );

  let text = (res?.response?.text?.() || '').trim();
  return text.replace(/^```[\s\S]*?\n?|```$/g, '').trim();
}

// ====== Retry helpers ======
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function parseGeminiError(e) {
  const msg = (e?.message || e?.toString() || '').toString();
  const status =
    e?.status ||
    e?.response?.status ||
    (/\b(\d{3})\b/.exec(msg)?.[1] ? Number(/\b(\d{3})\b/.exec(msg)[1]) : undefined);
  return { msg, status };
}
function isRetryableGeminiError(e) {
  const { msg, status } = parseGeminiError(e);

  // HTTP statuses
  if ([408, 425, 429, 500, 502, 503, 504].includes(status)) return true;

  // Network/undici-style errors (status undefined cases)
  if (/(overloaded|unavailable|timeout|timed out|fetch failed|socket hang up)/i.test(msg)) return true;

  // Node error codes
  const code = e?.code || e?.cause?.code;
  if (code && [
    'ECONNRESET','ETIMEDOUT','ENETUNREACH','EAI_AGAIN',
    'UND_ERR_CONNECT_TIMEOUT','UND_ERR_SOCKET','UND_ERR_HEADERS_TIMEOUT'
  ].includes(code)) return true;

  return false;
}
function logRetry(attempt, retries, modelName, err) {
  const { msg, status } = parseGeminiError(err);
  const code = err?.code || err?.cause?.code || 'NA';
  console.warn(`[GENAI] attempt=${attempt}/${retries} model=${modelName} status=${status ?? 'NA'} code=${code} retryable=${isRetryableGeminiError(err)}: ${msg}`);
}

// high-level OCR with retries + fallback
async function runGeminiExtractTextWithRetry(originalBuf, compressedBuf, mime = 'image/jpeg', {
  retries = 3,
  baseDelay = 1000,
} = {}) {
  const models = ['gemini-1.5-flash', 'gemini-1.5-flash-8b'];
  const buffers = [originalBuf, compressedBuf];
  let lastError;

  for (let attempt = 1; attempt <= retries; attempt++) {
    const delay = baseDelay * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 300);

    for (const buf of buffers) {
      for (const modelName of models) {
        try {
          const text = await runGeminiExtractText(buf, mime, { modelName, timeoutMs: GEMINI_TIMEOUT_MS });
          if (text && text.length) {
            if (attempt > 1) console.log(`[GENAI] success after retry #${attempt}, model=${modelName}, len=${text.length}`);
            return { text, lastError: undefined };
          }
        } catch (e) {
          lastError = e;
          logRetry(attempt, retries, modelName, e);

          const retryable = isRetryableGeminiError(e);
          if (attempt < retries && retryable) {
            await sleep(delay);
          } else if (!retryable) {
            return { text: '', lastError };
          }
        }
      }
    }
  }
  return { text: '', lastError };
}

// ====== Keyword matching (DB-driven) ======

// cache keywords to reduce DB hits
const KEYWORD_CACHE_TTL_MS = isProd ? 30_000 : 10_000;
let _kwCache = { ts: 0, items: [] };

async function loadKeywordsCached() {
  const now = Date.now();
  if (now - _kwCache.ts < KEYWORD_CACHE_TTL_MS && _kwCache.items.length) {
    return _kwCache.items;
  }
  const items = await Keyword.find({}).select('_id word norm').lean();
  _kwCache = { ts: now, items };
  return items;
}

function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function buildFlexibleRegex(word) {
  const parts = [...word].map(ch => escapeRegExp(ch)).join('\\W*');
  return new RegExp(`\\b${parts}\\b`);
}
function normalizeTightLower(s) {
  return mapConfusablesToLatin(
    s.toLowerCase()
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
function findKeywordMatches(rawText, keywords) {
  const matches = [];
  if (!rawText) return matches;

  const normalized = normalizeTightLower(rawText);

  for (const k of keywords) {
    const word = (k.word || '').toString();
    const norm = (k.norm || '').toString();
    if (!word) continue;

    // exact-case
    try {
      const exactRx = new RegExp(`\\b${escapeRegExp(word)}\\b`);
      if (exactRx.test(rawText)) {
        matches.push({ id: String(k._id), word, norm, matchedAs: 'exact' });
        continue;
      }
    } catch {}

    // flexible separators
    try {
      const flexRx = buildFlexibleRegex(word);
      if (flexRx.test(rawText)) {
        matches.push({ id: String(k._id), word, norm, matchedAs: 'flex' });
        continue;
      }
    } catch {}

    // normalized includes
    if (norm && normalized.includes(norm.replace(/\s+/g, ''))) {
      matches.push({ id: String(k._id), word, norm, matchedAs: 'normalized' });
      continue;
    }
  }
  return matches;
}
function decideLabelFromMatches(matches) {
  if (!matches.length) return null;
  const set = new Set(matches.map(m => m.norm));
  if (set.has('not spam')) return { label: 'Not Spam', isSpam: false };
  if (set.has('spam')) return { label: 'Spam', isSpam: true };
  if (set.has('suspected spam')) return { label: 'Suspected Spam', isSpam: true };
  return { label: [...set][0], isSpam: null };
}

// ====== CMS payload shaper ======
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

// ====== socket emitter ======
function emitScreenshotEvent(kind, docOrObj) {
  try {
    const io = getIO();
    const data = docOrObj._id ? shape(docOrObj) : docOrObj;
    io.to(Rooms.all).emit(kind, data);
    if (data.user) io.to(Rooms.user(String(data.user))).emit(kind, data);
    if (data.email) io.to(Rooms.email(String(data.email))).emit(kind, data);
    io.to(Rooms.admins).emit(kind, data);
  } catch (e) {
    console.warn('WS emit skipped:', e.message);
  }
}

// ====== main upload route ======
const uploadScreenshot = async (req, res) => {
  try {
    if (!req.user?.id) return res.status(401).json({ success: false, message: "Auth required" });
    if (!req.user?.email) return res.status(400).json({ success: false, message: "Email is required" });
    if (!req.user?.name) return res.status(400).json({ success: false, message: "Name is required" });
    if (!req.file?.buffer) return res.status(400).json({ success: false, message: "No file uploaded" });

    const today = new Date().toISOString().split("T")[0];
    const folderName = `screenshots/${req.user.id}/${today}`;

    const compressedBuffer = await compressImageBuffer(req.file.buffer);
    const uploadResult = await streamUpload(compressedBuffer, folderName);

    // ---- Gemini OCR (queued) with retry/fallback ----
    let text = "";
    let genaiError;
    try {
      const mime = req.file.mimetype || 'image/jpeg';
      const { text: out, lastError } = await withQueue(() =>
        runGeminiExtractTextWithRetry(
          req.file.buffer,
          compressedBuffer,
          mime,
          { retries: 3, baseDelay: isProd ? 1500 : 900 } // 1.5s -> 3s -> 6s
        )
      );
      text = out || "";
      genaiError = lastError ? (lastError.message || String(lastError)) : undefined;
      console.log(`[GENAI] len=${text.length} retry_err=${genaiError ? '1' : '0'}`);
    } catch (e) {
      console.warn("Gemini issue (wrapper catch):", e.message);
      genaiError = e.message;
    }

    // ---- Keyword detection ----
    let keywordMatches = [];
    let keywordDecision = null;
    try {
      const keywords = await loadKeywordsCached(); // [{_id, word, norm}]
      keywordMatches = findKeywordMatches(text, keywords);
      keywordDecision = decideLabelFromMatches(keywordMatches);
    } catch (e) {
      console.warn('Keyword detection failed:', e.message);
    }
    const keywordFound = keywordMatches.length > 0;
    const matchedKeywords = Array.from(new Set(keywordMatches.map(k => k.word)));

    // ---- Decide isSpam ----
    let isSpamFinal;
    if (keywordDecision && typeof keywordDecision.isSpam === 'boolean') {
      isSpamFinal = keywordDecision.isSpam;
    } else {
      isSpamFinal = hasSpam(text);
    }

    // ---- Extract number (simple pattern) ----
    const phoneMatches = text?.match(/\+?[0-9][0-9\s\-()]{7,}/g);
    const extracted = phoneMatches?.[0]?.replace(/\s+/g, " ").trim() || "Not Found";

    // ---- Save doc ----
    const doc = await AnalyzedScreenshot.create({
      user: req.user.id,
      name: req.user.name,
      email: req.user.email,
      imageUrl: uploadResult.secure_url,
      extractedNumber: extracted,
      time: new Date(),
      toNumber: req.body.toNumber || "Unknown",
      carrier: req.body.carrier || "Unknown",
      isSpam: isSpamFinal,
    });

    // ---- Response ----
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
        keywordFound,        
        matchedKeywords,     
      },
    };

    emitScreenshotEvent(Events.NEW, doc);

    if (req.query.debug === "1") {
      payload.data.rawOCR = text;
      payload.data.normalized = normalizeForOCR(text);
      payload.data.env = { isProd, timeoutMs: GEMINI_TIMEOUT_MS, model: 'gemini-1.5-flash' };
      payload.data.keywordMatches = keywordMatches; // detailed [{id, word, norm, matchedAs}]
      payload.data.keywordLabel = keywordDecision?.label || null;
      if (genaiError) payload.data.genaiError = genaiError;
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
