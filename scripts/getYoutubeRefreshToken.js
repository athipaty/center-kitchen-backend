/**
 * getYoutubeRefreshToken.js — one-time local OAuth flow to mint a YouTube refresh token.
 *
 * Usage:
 *   node scripts/getYoutubeRefreshToken.js
 *
 * Requires YOUTUBE_CLIENT_ID / YOUTUBE_CLIENT_SECRET already set in backend/.env (Desktop app
 * OAuth client from Google Cloud Console). Opens a URL for you to approve in your browser, catches
 * the redirect on a throwaway local server, exchanges the code for tokens, and prints the refresh
 * token to paste into .env as YOUTUBE_REFRESH_TOKEN.
 */
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const http = require("http");
const { google } = require("googleapis");

const PORT = 4321;
const REDIRECT_URI = `http://localhost:${PORT}`;

async function main() {
  const { YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET } = process.env;
  if (!YOUTUBE_CLIENT_ID || !YOUTUBE_CLIENT_SECRET) {
    console.error("Missing YOUTUBE_CLIENT_ID / YOUTUBE_CLIENT_SECRET in backend/.env — add those first.");
    process.exit(1);
  }

  const oauth2Client = new google.auth.OAuth2(YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, REDIRECT_URI);
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline", // required to get a refresh_token back, not just an access_token
    prompt: "consent", // forces the consent screen every run, so a refresh_token is issued even on repeat runs
    scope: ["https://www.googleapis.com/auth/youtube.upload"],
  });

  console.log("\n1. Open this URL in a browser signed into the YouTube channel's Google account:\n");
  console.log(authUrl);
  console.log("\n2. Approve access. This script will catch the redirect automatically.\n");
  console.log(`Waiting on http://localhost:${PORT} ...`);

  const code = await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, REDIRECT_URI);
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      res.end(error ? `Error: ${error} — check the terminal and close this tab.` : "Success — you can close this tab and go back to the terminal.");
      server.close();
      if (error) reject(new Error(error));
      else resolve(code);
    });
    server.listen(PORT);
  });

  const { tokens } = await oauth2Client.getToken(code);
  if (!tokens.refresh_token) {
    console.error("\nNo refresh_token in the response — this Google account may have already granted");
    console.error("consent before without a fresh prompt. Revoke access at https://myaccount.google.com/permissions");
    console.error("for this app and re-run this script.");
    process.exit(1);
  }

  console.log("\nAdd this line to backend/.env:\n");
  console.log(`YOUTUBE_REFRESH_TOKEN=${tokens.refresh_token}`);
  console.log();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
