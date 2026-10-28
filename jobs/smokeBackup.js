// Weekly encrypted backup of Smoke Finder's community data (what can't be
// rebuilt from NEA / OpenStreetMap) to B2. The bucket is public (it serves
// photos), so the file is gzipped EJSON encrypted with AES-256-GCM using
// SMOKE_BACKUP_KEY (32 random bytes, base64). Without that key it can't be read.
// Restore with scripts/smoke-restore-backup.js. Keeps the newest KEEP files.
//
// File layout: "SFB1" | 12-byte IV | 16-byte auth tag | ciphertext
const crypto = require("crypto");
const zlib = require("zlib");
const cron = require("node-cron");
const mongoose = require("mongoose");
const { EJSON } = require("bson");
const { uploadToB2, listB2Files, deleteB2File, b2KeyFromUrl, b2Enabled } = require("../utils/b2Utils");
const { notifyModerator } = require("../routes/smoke/notify");

// Community data only: map zones, NEA areas and metadata come back with a refresh;
// check-ins and error reports are short-lived on purpose.
const COLLECTIONS = ["smokespots", "smokereports", "smokestats", "smokedevices", "smokealerts"];
const PREFIX = "smoke-backups/";
const KEEP = 8;
const MAGIC = Buffer.from("SFB1");

function backupKey() {
  const key = Buffer.from(process.env.SMOKE_BACKUP_KEY ?? "", "base64");
  if (key.length !== 32) throw new Error("SMOKE_BACKUP_KEY must be 32 random bytes, base64");
  return key;
}

function encrypt(plain, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), body]);
}

// The backup as { createdAt, collections: { name: [docs] } }; throws if the key is wrong or the file damaged.
function decryptBackup(file, key = backupKey()) {
  if (!file.subarray(0, 4).equals(MAGIC)) throw new Error("not a Smoke Finder backup file");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, file.subarray(4, 16));
  decipher.setAuthTag(file.subarray(16, 32));
  const plain = Buffer.concat([decipher.update(file.subarray(32)), decipher.final()]);
  return EJSON.parse(zlib.gunzipSync(plain).toString("utf8"));
}

async function backupOnce({ prefix = PREFIX, keep = KEEP } = {}) {
  if (!b2Enabled()) throw new Error("B2 storage is not set up");
  const key = backupKey();
  const db = mongoose.connection.db;
  const collections = {};
  const counts = {};
  for (const name of COLLECTIONS) {
    collections[name] = await db.collection(name).find().toArray();
    counts[name] = collections[name].length;
  }
  const createdAt = new Date();
  const plain = zlib.gzipSync(Buffer.from(EJSON.stringify({ createdAt, collections }, { relaxed: false })));
  const file = encrypt(plain, key);
  const fileKey = `${prefix}${createdAt.toISOString().slice(0, 10)}-${crypto.randomBytes(6).toString("hex")}.sfbak`;
  await uploadToB2(file, fileKey, "application/octet-stream", "private, no-store");

  // Keep the newest `keep` (names start with the date, so they sort by age).
  const existing = (await listB2Files(prefix)).map(b2KeyFromUrl).filter(Boolean).sort();
  for (const old of existing.slice(0, Math.max(0, existing.length - keep))) await deleteB2File(old);

  const summary = { at: createdAt, file: fileKey, bytes: file.length, counts, kept: Math.min(existing.length, keep) };
  if (prefix === PREFIX) await db.collection("smokemeta").updateOne({ _id: "backup" }, { $set: summary }, { upsert: true });
  return summary;
}

function start() {
  if (!process.env.SMOKE_BACKUP_KEY || !b2Enabled()) {
    console.log("smokeBackup: SMOKE_BACKUP_KEY or B2 not set, weekly backup disabled");
    return;
  }
  // Sundays 03:00 Singapore time.
  cron.schedule(
    "0 3 * * 0",
    () =>
      backupOnce()
        .then((s) => console.log("[smokeBackup]", JSON.stringify({ file: s.file, bytes: s.bytes, counts: s.counts })))
        .catch((err) => {
          console.error("[smokeBackup] error:", err.message);
          notifyModerator("Smoke Finder: weekly backup failed", `The encrypted backup to B2 didn't work: ${err.message.slice(0, 160)}`);
        }),
    { timezone: "Asia/Singapore" }
  );
  console.log("✅ smokeBackup scheduled: Sundays 03:00 SGT, keeps the last 8");
}

module.exports = { start, backupOnce, decryptBackup, COLLECTIONS, PREFIX };
