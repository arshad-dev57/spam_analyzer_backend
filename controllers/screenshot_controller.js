const fs = require('fs');
const path = require('path');
const cloudinary = require('../config/cloudinary');
const tesseract = require('tesseract.js');
const sharp = require('sharp');
const streamifier = require('streamifier');

const Screenshot = require('../models/screenshots');
const AnalyzedScreenshot = require('../models/analyzedScreenshot');

const uploadScreenshot = async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, message: 'No file uploaded' });
  }

  const filePath = req.file.path;

  try {
    // 📁 Cloudinary folder name by date
    const folderName = `screenshots/${new Date().toISOString().split('T')[0]}`;

    // 📦 Compress image
    const compressedBuffer = await compressImage(filePath);

    // ☁️ Upload to Cloudinary
    const result = await streamUpload(compressedBuffer, folderName);

    // 🧠 OCR: Extract text from image
    const { data: { text } } = await tesseract.recognize(filePath, 'eng');
    console.log('🧠 Extracted Text:', text);

    // 🔍 Spam keyword check
    const containsApam = /apam/i.test(text); // isSpam = true if "apam" exists

    // ☎️ Extract phone number
    const matches = text.match(/\+?[0-9][0-9\s\-()]{7,}/g);
    const extracted = matches?.[0].trim() || 'Not Found';

    // 💾 Save analyzed screenshot to MongoDB
    const newAnalyzed = new AnalyzedScreenshot({
      imageUrl: result.secure_url,
      extractedNumber: extracted,
      time: new Date(),
      toNumber: req.body.toNumber || 'Unknown',
      carrier: req.body.carrier || 'Unknown',
      isSpam: containsApam, // ✅ Save isSpam result
    });

    await newAnalyzed.save();
    fs.unlinkSync(filePath); // 🧹 Remove temp file

    // ✅ Send API response
    res.status(201).json({
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
    res.status(500).json({ success: false, error: err.message });
  }
};

// 🔧 Compress uploaded image under 100 KB
async function compressImage(imagePath) {
  const targetSize = 100 * 1024;
  let quality = 80;
  let width = 1000;
  const buffer = fs.readFileSync(imagePath);
  let compressedBuffer = buffer;

  while (width >= 200) {
    let currentQuality = quality;
    while (currentQuality >= 30) {
      compressedBuffer = await sharp(buffer)
        .resize({ width, withoutEnlargement: true })
        .jpeg({ quality: currentQuality })
        .toBuffer();

      if (compressedBuffer.byteLength <= targetSize) {
        return compressedBuffer;
      }

      currentQuality -= 10;
    }

    width -= 100;
  }

  console.warn(`⚠️ Could not compress below 100 KB. Final size: ${(compressedBuffer?.byteLength / 1024).toFixed(1)} KB`);
  return compressedBuffer;
}

// 📤 Stream image buffer to Cloudinary
function streamUpload(buffer, folder) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder },
      (error, result) => {
        if (result) {
          resolve(result);
        } else {
          reject(error);
        }
      }
    );
    streamifier.createReadStream(buffer).pipe(stream);
  });
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
