// Reads a Smoke Finder backup (jobs/smokeBackup.js) and, if asked, restores it.
//
//   node scripts/smoke-restore-backup.js <backup-url-or-file>
//       decrypts it and prints what's inside (nothing is written)
//   node scripts/smoke-restore-backup.js <backup-url-or-file> --into <database>
//       copies it into <database> on the same MongoDB cluster; refuses if any of
//       the collections already has documents there, so live data is never overwritten
//
// Needs MONGO_URI and SMOKE_BACKUP_KEY (backend .env, or the environment).
// Backups are listed in B2 under smoke-backups/ (newest name = newest date).
require("dotenv").config({ quiet: true });
const fs = require("fs");
const mongoose = require("mongoose");
const { decryptBackup, COLLECTIONS } = require("../jobs/smokeBackup");

(async () => {
  const [source] = process.argv.slice(2);
  const into = process.argv.includes("--into") ? process.argv[process.argv.indexOf("--into") + 1] : null;
  if (!source) {
    console.error("Usage: node scripts/smoke-restore-backup.js <backup-url-or-file> [--into <database>]");
    process.exit(1);
  }
  const file = /^https?:\/\//.test(source) ? Buffer.from(await (await fetch(source)).arrayBuffer()) : fs.readFileSync(source);
  const backup = decryptBackup(file);
  console.log(`backup from ${new Date(backup.createdAt).toISOString()}`);
  for (const name of COLLECTIONS) console.log(`  ${name}: ${backup.collections[name]?.length ?? 0} documents`);
  if (!into) return console.log("(read only: add --into <database> to restore)");

  await mongoose.connect(process.env.MONGO_URI, { dbName: into });
  const db = mongoose.connection.db;
  for (const name of COLLECTIONS) {
    if (await db.collection(name).estimatedDocumentCount()) throw new Error(`${into}.${name} is not empty: refusing to overwrite`);
  }
  for (const name of COLLECTIONS) {
    const docs = backup.collections[name] ?? [];
    if (docs.length) await db.collection(name).insertMany(docs, { ordered: false });
    console.log(`  restored ${into}.${name}: ${docs.length}`);
  }
  await mongoose.disconnect();
})().catch((err) => {
  console.error("restore failed:", err.message);
  process.exit(1);
});
