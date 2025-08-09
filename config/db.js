// config/db.js
const mongoose = require('mongoose');

let isConnected = null;

const connectDB = async () => {
  if (isConnected) {
    console.log('⚡ MongoDB already connected');
    return;
  }

  try {
    const db = await mongoose.connect(process.env.MONGO_URI, {
      serverSelectionTimeoutMS: 10000
    });
    isConnected = db.connections[0].readyState;
    console.log('✅ MongoDB connected');
  } catch (error) {
    console.error('❌ MongoDB connection failed:', error);
    throw error;
  }
};

module.exports = connectDB;
