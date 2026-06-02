require('dotenv').config();
const mongoose = require('mongoose');

mongoose.connect(process.env.MONGO_URI).then(async () => {
  console.log('Running product discovery for 5 remaining slots...\n');
  const { runProductDiscovery } = require('./jobs/productDiscovery');
  await runProductDiscovery(null, 5);
  console.log('\nDone.');
  await mongoose.disconnect();
}).catch(e => { console.error(e.message); process.exit(1); });
