module.exports = {
    SALT_ROUNDS: 10,
    JWT_SECRET: process.env.JWT_SECRET, // ya hardcode mat karna; .env se lo
    JWT_EXPIRES_IN: '7d',
  };
  