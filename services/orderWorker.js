/**
 * orderWorker.js — Runs in a separate child_process.fork() so Chrome is
 * completely isolated from the Express server's event loop.
 *
 * Communication via process.send() / process.on('message')
 * Messages from parent: { account, date }
 * Messages to parent:   { log, warn, error, done, failed }
 */

const puppeteer = require('puppeteer');

function normalizeText(str) {
  return (str || '').replace(/[\r\n\t ]+/g, ' ').trim().toLowerCase();
}

function log(msg) { process.send({ type: 'log', msg }); }
function warn(msg) { process.send({ type: 'warn', msg }); }
function error(msg) { process.send({ type: 'error', msg }); }
function done() { process.send({ type: 'done' }); }
function failed(msg) { process.send({ type: 'failed', msg }); }

process.on('message', async ({ account, date }) => {
  // Route Chrome traffic through Every Proxy on the phone (Macedonian IP) via Tailscale.
  // Set SOCKS5_PROXY=<tailscale-phone-ip>:<every-proxy-port> in docker-compose.yml
  const proxyArgs = process.env.SOCKS5_PROXY
    ? [`--proxy-server=socks5://${process.env.SOCKS5_PROXY}`]
    : [];

  const browser = await puppeteer.launch({
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
    protocolTimeout: 120000,
    ignoreHTTPSErrors: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-web-security',
      '--allow-running-insecure-content',
      '--disable-dev-shm-usage',
      '--disable-features=IsolateOrigins,site-per-process,HttpsUpgrades,HttpsFirstModeIncognito,HttpsFirstModeV2,HttpsFirstBalancedModeAutoEnable',
      ...proxyArgs
    ]
  });

  const page = await browser.newPage();
  page.on('requestfailed', req => {
    warn(`Request failed: ${req.url()} - ${req.failure() ? req.failure().errorText : 'Unknown'}`);
  });

  try {
    log(`Account ${account.username}: Se otvora Login stranata...`);
    await page.goto('http://217.16.86.112/MatrixTables/Login.aspx', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('input[name="ctl00$MainContent$UserName"]', { timeout: 10000 });

    await page.click('input[name="ctl00$MainContent$UserName"]', { clickCount: 3 });
    await page.type('input[name="ctl00$MainContent$UserName"]', account.username);
    await page.click('input[name="ctl00$MainContent$Password"]', { clickCount: 3 });
    await page.type('input[name="ctl00$MainContent$Password"]', account.password);

    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }),
      page.click('input[name="ctl00$MainContent$LoginButton"]')
    ]);

    log(`Account ${account.username}: Logiran!`);

    if (!page.url().includes('Items_x_Clients.aspx')) {
      await page.goto('http://217.16.86.112/MatrixTables/Items_x_Clients.aspx', { waitUntil: 'domcontentloaded' });
    }
    await page.waitForSelector('#MainContent_Pivot', { timeout: 15000 });

    for (const task of account.driverTasks) {
      const { driver, items } = task;
      const searchText = normalizeText(driver.portal_column_id);

      const colResult = await page.evaluate((searchNorm) => {
        function norm(s) { return (s || '').replace(/[\r\n\t ]+/g, ' ').trim().toLowerCase(); }
        const headers = Array.from(document.querySelectorAll('#MainContent_Pivot thead tr td'));
        let found = -1;
        for (let i = 0; i < headers.length; i++) {
          const text = norm(headers[i].innerText);
          const title = norm(headers[i].getAttribute('title') || '');
          if (text.includes(searchNorm) || title.includes(searchNorm) || searchNorm.includes(text)) {
            found = i;
            break;
          }
        }
        return { found };
      }, searchText);

      if (colResult.found === -1) {
        error(`Account ${account.username} / Vozach ${driver.name}: Kolonata "${driver.portal_column_id}" ne e pronadjdena!`);
        continue;
      }

      log(`Account ${account.username} / Vozach ${driver.name}: Kolona e ${colResult.found}. Se popolnuvaat ${items.length} artikli...`);

      for (const item of items) {
        const extCode = (item.external_code || item.code).toString().trim();
        await page.evaluate((code, qty, colIdx) => {
          const rows = document.querySelectorAll('#MainContent_Pivot tbody tr');
          for (let i = 0; i < rows.length; i++) {
            const codeCell = rows[i].querySelector('td:first-child');
            if (codeCell && codeCell.innerText.trim() === code) {
              const input = rows[i].querySelector('td:nth-child(' + (colIdx + 1) + ') input');
              if (input) {
                input.focus();
                input.value = qty;
                input.dispatchEvent(new Event('change', { bubbles: true }));
                input.dispatchEvent(new Event('blur', { bubbles: true }));
                return;
              }
            }
          }
        }, extCode, item.total_qty, colResult.found);
      }
    }

    log(`Account ${account.username}: Klikam na kopcheto za Naracaj...`);
    await page.waitForSelector('#MainContent_SubmitOrders, input[name="ctl00$MainContent$SubmitOrders"]', { timeout: 5000 });
    await page.click('#MainContent_SubmitOrders, input[name="ctl00$MainContent$SubmitOrders"]');

    log(`Account ${account.username}: Cekkam potvrden dijalog (Prodolzi)...`);
    try {
      await page.waitForSelector('.ui-dialog-buttonpane button, .ui-dialog button', { visible: true, timeout: 5000 });

      const btnText = await page.evaluate(() => {
        const dlgBtns = Array.from(document.querySelectorAll('.ui-dialog-buttonpane button, .ui-dialog button'));
        const confirmBtn = dlgBtns.find(b => {
          const t = (b.innerText || '').toLowerCase();
          return t.includes('продолжи') || t.includes('prodolzi') || t.includes('ok') || t.includes('yes') || t.includes('да');
        }) || dlgBtns[0];
        if (confirmBtn) { confirmBtn.click(); return confirmBtn.innerText.trim(); }
        return 'none';
      });
      log(`Account ${account.username}: Kliknato na dijalog kopce: "${btnText}". Cekkam 3s...`);

      // Portal most likely does NOT navigate — it shows an in-place message.
      // Wait 3s for the server-side postback to complete instead of blocking on navigation.
      await new Promise(r => setTimeout(r, 3000));
    } catch (e) {
      log(`Account ${account.username}: Nema potvrduvacki dijalog (mozno e direktno isprateno).`);
    }

    const message = await page.evaluate(() => {
      const msg = document.querySelector('#MainContent_LabelMessage, span[id*="LabelMessage"]');
      return msg ? msg.innerText : null;
    });

    if (message) log(`Account ${account.username}: Poraka od portal: "${message}"`);
    log(`Account ${account.username}: Narachkata e uspeshno ispratena za site vozachi na ovoj account!`);

    done();

  } catch (err) {
    error(`Account ${account.username} greshka: ${err.message}`);
    await new Promise(r => setTimeout(r, 3000));
    failed(err.message);
  } finally {
    await browser.close();
  }
});
