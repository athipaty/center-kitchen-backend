require('dotenv').config();
const mongoose = require('mongoose');

const SOURCE_DB = 'test';
const TARGET_DB = 'centerkitchen';

async function migrate() {
  // Connect to source
  const sourceConn = await mongoose.createConnection(
    process.env.MONGO_URI.replace('/centerkitchen', `/${SOURCE_DB}`)
  ).asPromise();

  // Connect to target
  const targetConn = await mongoose.createConnection(
    process.env.MONGO_URI.replace('/centerkitchen', `/${TARGET_DB}`)
  ).asPromise();

  // Get all collections from source
  const collections = await sourceConn.db.listCollections().toArray();
  console.log(`Found ${collections.length} collections in ${SOURCE_DB}:`, collections.map(c => c.name));

  for (const col of collections) {
    const name = col.name;
    console.log(`\nMigrating: ${name}...`);

    const docs = await sourceConn.db.collection(name).find({}).toArray();
    console.log(`  Found ${docs.length} documents`);

    if (docs.length > 0) {
      await targetConn.db.collection(name).insertMany(docs);
      console.log(`  ✅ Inserted ${docs.length} documents into ${TARGET_DB}.${name}`);
    } else {
      console.log(`  ⚠ Skipped — empty collection`);
    }
  }

  console.log('\n✅ Migration complete!');
  await sourceConn.close();
  await targetConn.close();
  process.exit(0);
}

migrate().catch(err => {
  console.error('❌ Migration failed:', err);
  process.exit(1);
});