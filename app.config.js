const appJson = require('./app.json');

module.exports = {
  ...appJson.expo,
  extra: {
    geminiApiKey: process.env.GEMINI_API_KEY ?? null,
    appMode: process.env.APP_MODE ?? null,
  },
};
