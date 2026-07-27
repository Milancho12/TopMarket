const { fork } = require('child_process');
const path = require('path');
const { db } = require('../database');

function today() { return new Date().toISOString().split('T')[0]; }

// Global lock to prevent concurrent Puppeteer instances
let isRunning = false;

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

  // Check if already running
  if (isRunning) {
    console.warn(`Account ${account.username}: Puppeteer e veke aktiven (drug process raboti). Se preskacuva.`);
    return;
  }
  isRunning = true;

  return new Promise((resolve) => {
    // Fork a completely separate process for Chrome — isolated from Express's event loop
    const worker = fork(path.join(__dirname, 'orderWorker.js'), [], {
      env: process.env,
      silent: false   // Worker stdout/stderr flows directly to container logs
    });

    // Send the job to the worker
    worker.send({ account: { ...account, driverTasks }, date });

    // Relay worker log messages to our console
    worker.on('message', (msg) => {
      switch (msg.type) {
        case 'log':   console.log(msg.msg);   break;
        case 'warn':  console.warn(msg.msg);  break;
        case 'error': console.error(msg.msg); break;
        case 'done':
        case 'failed':
          isRunning = false;
          worker.kill();
          resolve();
          break;
      }
    });

    worker.on('error', (err) => {
      console.error(`Worker process error: ${err.message}`);
      isRunning = false;
      resolve();
    });

    worker.on('exit', (code) => {
      if (isRunning) {
        console.error(`Worker exited unexpectedly with code ${code}`);
        isRunning = false;
      }
      resolve();
    });
  });
}

// Keep the old function signature for individual test buttons
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
    console.log('Pauza od 2 minuti pred sledniot account...');
    await new Promise(r => setTimeout(r, 120000));
  }
}

module.exports = { runAllOrders, submitOrdersForDriver };
