const { Readable } = require("stream");
const { google } = require("googleapis");
const { getOAuth2Client } = require("./youtubeAuth");

// Publishes as "private" by default — these are AI-generated episodes, so they land on the
// channel unlisted-from-the-public until a human reviews and flips visibility in YouTube Studio,
// rather than auto-publishing straight to the world.
async function uploadVideoToYoutube(buffer, { title, description = "", privacyStatus = "private", tags = [], categoryId = "1" }) {
  const auth = getOAuth2Client();
  const youtube = google.youtube({ version: "v3", auth });

  const { data } = await youtube.videos.insert({
    part: ["snippet", "status"],
    requestBody: {
      snippet: { title, description, tags, categoryId }, // "1" = Film & Animation
      status: { privacyStatus, selfDeclaredMadeForKids: false },
    },
    media: { body: Readable.from(buffer) },
  });

  return { videoId: data.id, url: `https://www.youtube.com/watch?v=${data.id}` };
}

module.exports = { uploadVideoToYoutube };
