const puppeteer = require('puppeteer');
const { db } = require('../database');

function today() { return new Date().toISOString().split('T')[0]; }

// Normalize whitespace/newlines for flexible comparison
function normalizeText(str) {
  return (str || '').replace(/[\r\n\t ]+/g, ' ').trim().toLowerCase();
}

async function submitOrdersForAccount(account) {
  const date = today();
  
  // 1. Fetch items for all drivers in this account
  const driverTasks = [];
  for (const driver of account.drivers) {
    const items = await db.allAsync(`
      SELECT a.code, a.external_code, a.name, a.sort_order,
             COALESCE(SUM(di.next_day_qty), 0) total_qty
      FROM delivery_items di
      JOIN deliveries d ON d.id = di.delivery_id
      JOIN articles a ON a.id = di.article_id
      WHERE d.driver_id=? AND d.date=? AND di.next_day_qty > 0
      GROUP BY a.id
      ORDER BY a.sort_order`, [driver.id, date]);
      
    if (items.length > 0) {
      driverTasks.push({ driver, items });
    } else {
      console.log(`Account ${account.username}: Vozach ${driver.name} nema narachki za utre.`);
    }
  }

  if (driverTasks.length === 0) {
    console.log(`Account ${account.username}: Nema nitu eden vozach so narachki.`);
    return;
  }

  console.log(`Account ${account.username}: Pronadjeni narachki za ${driverTasks.length} vozachi.`);

  const browser = await puppeteer.launch({
    headless: false,
    defaultViewport: null,
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    ignoreHTTPSErrors: true,
    args: ['--start-maximized']
  });
  const page = await browser.newPage();

  page.on('requestfailed', request => {
    console.warn(`Blocked request: ${request.url()}`);
  });

  try {
    // 2. Go to login page
    console.log(`Account ${account.username}: Se otvora Login stranata...`);
    await page.goto('http://217.16.86.112/MatrixTables/Login.aspx', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('input[name="ctl00$MainContent$UserName"]', { timeout: 10000 });
    
    // Login
    await page.click('input[name="ctl00$MainContent$UserName"]', { clickCount: 3 });
    await page.type('input[name="ctl00$MainContent$UserName"]', account.username);
    await page.click('input[name="ctl00$MainContent$Password"]', { clickCount: 3 });
    await page.type('input[name="ctl00$MainContent$Password"]', account.password);
    
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }),
      page.click('input[name="ctl00$MainContent$LoginButton"]')
    ]);

    console.log(`Account ${account.username}: Logiran!`);

    // 3. Navigate to Items_x_Clients
    if (!page.url().includes('Items_x_Clients.aspx')) {
      await page.goto('http://217.16.86.112/MatrixTables/Items_x_Clients.aspx', { waitUntil: 'domcontentloaded' });
    }
    await page.waitForSelector('#MainContent_Pivot', { timeout: 15000 });

    // 4. Fill in each driver's column
    for (const task of driverTasks) {
      const { driver, items } = task;
      const searchText = normalizeText(driver.portal_column_id);

      // Find the column index
      const colResult = await page.evaluate((searchNorm) => {
        function norm(s) { return (s || '').replace(/[\r\n\t ]+/g, ' ').trim().toLowerCase(); }
        const headers = Array.from(document.querySelectorAll('#MainContent_Pivot thead tr td'));
        let found = -1;
        for (let i = 0; i < headers.length; i++) {
          const text = norm(headers[i].innerText);
          const title = norm(headers[i].getAttribute('title') || '');
          if (text.includes(searchNorm) || title.includes(searchNorm) || searchNorm.includes(text.substring(0, 10))) {
            found = i;
            break;
          }
        }
        return { found };
      }, searchText);

      if (colResult.found === -1) {
        console.error(`Account ${account.username} / Vozach ${driver.name}: Kolonata "${driver.portal_column_id}" ne e pronadjdena!`);
        continue; // Skip this driver, but let the others process
      }
      
      console.log(`Account ${account.username} / Vozach ${driver.name}: Kolona e ${colResult.found}. Se popolnuvaat ${items.length} artikli...`);

      // Fill in rows for this driver
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

    // 5. Submit the form for ALL filled columns
    console.log(`Account ${account.username}: Klikam na kopcheto za Naracaj...`);
    await page.waitForSelector('#MainContent_SubmitOrders, input[name="ctl00$MainContent$SubmitOrders"]', { timeout: 5000 });
    await page.click('#MainContent_SubmitOrders, input[name="ctl00$MainContent$SubmitOrders"]');

    // Handle confirmation dialog
    console.log(`Account ${account.username}: Cekkam potvrden dijalog (Prodolzi)...`);
    try {
      await page.waitForSelector('.ui-dialog-buttonpane button, .ui-dialog button', { visible: true, timeout: 5000 });
      await page.evaluate(() => {
        const dlgBtns = Array.from(document.querySelectorAll('.ui-dialog-buttonpane button, .ui-dialog button'));
        const confirmBtn = dlgBtns.find(b => {
          const t = (b.innerText || '').toLowerCase();
          return t.includes('продолжи') || t.includes('prodolzi') || t.includes('ok') || t.includes('yes') || t.includes('да');
        }) || dlgBtns[0];
        if (confirmBtn) confirmBtn.click();
      });
      await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    } catch (e) {
      // no dialog appeared
    }

    // Check message
    const message = await page.evaluate(() => {
      const msg = document.querySelector('#MainContent_LabelMessage, span[id*="LabelMessage"]');
      return msg ? msg.innerText : null;
    });

    if (message) console.log(`Account ${account.username}: Poraka od portal: "${message}"`);
    console.log(`Account ${account.username}: Narachkata e uspeshno ispratena za site vozachi na ovoj account!`);

    await new Promise(r => setTimeout(r, 4000));

  } catch (err) {
    console.error(`Account ${account.username} greshka:`, err.message);
    await new Promise(r => setTimeout(r, 10000));
  } finally {
    await browser.close();
  }
}

// Keep the old function signature for individual test buttons, but wrap it
async function submitOrdersForDriver(driver) {
  return submitOrdersForAccount({
    username: driver.portal_username,
    password: driver.portal_password,
    drivers: [driver]
  });
}

async function runAllOrders() {
  const drivers = await db.allAsync("SELECT * FROM users WHERE role='driver' AND active=1 AND portal_username IS NOT NULL AND portal_password IS NOT NULL AND portal_column_id IS NOT NULL");
  
  // Group by account
  const accountsMap = {};
  for (const d of drivers) {
    if (d.portal_username.trim() === '') continue;
    const key = `${d.portal_username.trim()}|${d.portal_password.trim()}`;
    if (!accountsMap[key]) {
      accountsMap[key] = { username: d.portal_username.trim(), password: d.portal_password.trim(), drivers: [] };
    }
    accountsMap[key].drivers.push(d);
  }
  
  const accounts = Object.values(accountsMap);
  console.log(`Zapocnuva avtomatsko isprakanje na narachki za ${drivers.length} vozaci (grupisani vo ${accounts.length} accounti).`);
  
  for (const acc of accounts) {
    await submitOrdersForAccount(acc);
    // Add a 2 minute delay (120,000 ms) between different accounts, just to be safe with the portal
    console.log('Pauza od 2 minuti pred sledniot account...');
    await new Promise(r => setTimeout(r, 120000));
  }
}

module.exports = { runAllOrders, submitOrdersForDriver };
