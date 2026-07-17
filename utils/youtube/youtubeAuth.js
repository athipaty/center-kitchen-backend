const { google } = require("googleapis");

// Desktop-app OAuth client type accepts any http://localhost:<port> redirect URI without
// pre-registering it in the Cloud Console, so getYoutubeRefreshToken.js can pick a free port.
const REDIRECT_URI = "http://localhost";

function getOAuth2Client() {
  const { YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, YOUTUBE_REFRESH_TOKEN } = process.env;
  if (!YOUTUBE_CLIENT_ID || !YOUTUBE_CLIENT_SECRET) {
    throw new Error("YOUTUBE_CLIENT_ID / YOUTUBE_CLIENT_SECRET missing from .env");
  }
  const client = new google.auth.OAuth2(YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, REDIRECT_URI);
  if (YOUTUBE_REFRESH_TOKEN) client.setCredentials({ refresh_token: YOUTUBE_REFRESH_TOKEN });
  return client;
}

module.exports = { getOAuth2Client, REDIRECT_URI };
