const { Readable } = require("stream");
const { google } = require("googleapis");
const { getOAuth2Client } = require("./youtubeAuth");

// privacyStatus/selfDeclaredMadeForKids are chosen per-episode on the pre-upload review dialog
// (see Episode.youtubePrivacyStatus/youtubeMadeForKids) rather than fixed here — this app's
// content is kids' fables meant to go live once rendered, so "private"/false (this function's own
// fallback if a caller omits them) would leave the video unpublished and incorrectly
// self-declared; the caller is expected to always pass the episode's actual chosen values.
async function uploadVideoToYoutube(
  buffer,
  { title, description = "", privacyStatus = "private", selfDeclaredMadeForKids = false, tags = [], categoryId = "1" }
) {
  const auth = getOAuth2Client();
  const youtube = google.youtube({ version: "v3", auth });

  const { data } = await youtube.videos.insert({
    part: ["snippet", "status"],
    requestBody: {
      snippet: { title, description, tags, categoryId }, // "1" = Film & Animation
      status: { privacyStatus, selfDeclaredMadeForKids },
    },
    media: { body: Readable.from(buffer) },
  });

  return { videoId: data.id, url: `https://www.youtube.com/watch?v=${data.id}` };
}

module.exports = { uploadVideoToYoutube };
