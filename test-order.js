const { submitOrdersForDriver } = require('./services/orderSubmitter');
const { db } = require('./database');

(async () => {
  const driver = await db.getAsync("SELECT * FROM users WHERE role='driver' AND active=1 AND portal_username IS NOT NULL AND portal_username != '' LIMIT 1");
  if (!driver) {
    console.log('No driver found');
    process.exit(0);
  }
  console.log('Testing driver:', driver.portal_username, 'column:', driver.portal_column_id);
  await submitOrdersForDriver(driver);
  process.exit(0);
})().catch(e => { console.error('TOP ERROR:', e); process.exit(1); });
