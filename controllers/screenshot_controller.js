const cloudinary = require('../config/cloudinary');
const tesseract = require('tesseract.js');
const sharp = require('sharp');
const AnalyzedScreenshot = require('../models/analyzedScreenshot');

const uploadScreenshot = async (req, res, next) => {
  try {
    if (!req.file?.buffer) {
      return res.status(400).json({ success: false, message: 'No file uploaded' });
    }

    const folderName = `screenshots/${new Date().toISOString().split('T')[0]}`;

    // 1) Compress FROM BUFFER (no disk I/O)
    const compressedBuffer = await compressImageBuffer(req.file.buffer);

    // 2) Upload to Cloudinary FROM BUFFER
    const result = await streamUpload(compressedBuffer, folderName);

    // 3) OCR on BUFFER (no file path)
    const { data: { text } } = await tesseract.recognize(compressedBuffer, 'eng');
    const containsSpam = /spam/i.test(text);
    const matches = text.match(/\+?[0-9][0-9\s\-()]{7,}/g);
    const extracted = matches?.[0]?.trim() || 'Not Found';

    // 4) Save to DB
    const newAnalyzed = await AnalyzedScreenshot.create({
      imageUrl: result.secure_url,
      extractedNumber: extracted,
      time: new Date(),
      toNumber: req.body.toNumber || 'Unknown',
      carrier: req.body.carrier || 'Unknown',
      isSpam: containsSpam,
    });

    // 5) Respond
    return res.status(201).json({
      success: true,
      data: {
        screenshotUrl: result.secure_url,
        extractedNumber: extracted,
        id: newAnalyzed._id,
        time: newAnalyzed.time,
        toNumber: newAnalyzed.toNumber,
        carrier: newAnalyzed.carrier,
        isSpam: newAnalyzed.isSpam,
      },
    });
  } catch (err) {
    console.error('❌ Upload error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

async function compressImageBuffer(inputBuffer) {
  const targetSize = 100 * 1024; 
  let quality = 80;
  let width = 1000;
  let best = inputBuffer;

  while (width >= 200) {
    let q = quality;
    while (q >= 30) {
      const out = await sharp(inputBuffer)
        .resize({ width, withoutEnlargement: true })
        .jpeg({ quality: q })
        .toBuffer();

      if (out.byteLength <= targetSize) return out;
      best = out;
      q -= 10;
    }
    width -= 100;
  }
  return best; // couldn't reach 100KB, return smallest tried
}

const getAllAnalyzedScreenshots = async (req, res) => {
  try {
    const all = await AnalyzedScreenshot.find().sort({ analyzedAt: -1 });

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
      })),
    });
  } catch (err) {
    console.error('❌ Fetch error:', err);
    res.status(500).json({ success: false, error: 'Server error' });
  }
};
module.exports = {
  uploadScreenshot,
  getAllAnalyzedScreenshots,
};
