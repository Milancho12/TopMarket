const puppeteer = require('puppeteer');
(async () => {
  console.log('PUPPETEER_EXECUTABLE_PATH:', process.env.PUPPETEER_EXECUTABLE_PATH);
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
    ignoreHTTPSErrors: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-web-security',
      '--allow-running-insecure-content',
      '--disable-dev-shm-usage',
      '--disable-features=IsolateOrigins,site-per-process,HttpsUpgrades,HttpsFirstModeIncognito,HttpsFirstModeV2,HttpsFirstBalancedModeAutoEnable'
    ]
  });
  const page = await browser.newPage();
  page.on('requestfailed', req => console.log('Failed:', req.url(), req.failure() && req.failure().errorText));
  page.on('response', res => { if (res.url().includes('Login')) console.log('Response:', res.url(), res.status()); });
  try {
    console.log('Navigating...');
    await page.goto('http://217.16.86.112/MatrixTables/Login.aspx', { waitUntil: 'domcontentloaded', timeout: 15000 });
    console.log('Success:', page.url());
  } catch (e) {
    console.log('Error:', e.message);
  }
  await browser.close();
})();
