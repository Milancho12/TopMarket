const puppeteer = require('puppeteer');
(async () => {
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const page = await browser.newPage();
  page.on('requestfailed', req => console.log('Failed:', req.url(), req.failure().errorText));
  try {
    await page.goto('http://217.16.86.112/MatrixTables/Login.aspx', { waitUntil: 'domcontentloaded' });
    console.log('Success:', page.url());
  } catch (e) {
    console.log('Error:', e.message);
  }
  await browser.close();
})();
