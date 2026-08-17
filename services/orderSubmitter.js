const { fork } = require('child_process');
const path = require('path');
const { db } = require('../database');

function today() { return new Date().toISOString().split('T')[0]; }

/**
 * Per-account queue — key = "portal_username|portal_password"
 * Each value is the tail of a Promise chain for that account.
 * If the same account is triggered twice, the second call waits
 * for the first to finish before starting its own worker.
 */
const accountQueues = new Map();

/**
 * Enqueue a run for a given account.
 * Returns a Promise that resolves when THIS run finishes.
 */
function enqueueAccount(account) {
  const key = `${account.username}|${account.password}`;
  // Chain onto whatever is already queued for this account
  const prev = accountQueues.get(key) || Promise.resolve();
  const next = prev
    .then(() => submitOrdersForAccount(account))
    .catch(err => console.error(`[Queue] Error for account ${account.username}:`, err));
  accountQueues.set(key, next);
  // Clean up the map entry once this run is the last one
  next.finally(() => {
    if (accountQueues.get(key) === next) accountQueues.delete(key);
  });
  return next;
}

async function submitOrdersForAccount(account) {
  const date = today();

  // 1. Fetch items for all drivers in this account
  const driverTasks = [];
  for (const driver of account.drivers) {
    // Normal market next_day quantities (is_market_article=0, market is NOT large)
    const normalItems = await db.allAsync(`
      SELECT a.code, a.external_code, a.name, a.sort_order,
             COALESCE(SUM(di.next_day_qty), 0) total_qty
      FROM delivery_items di
      JOIN deliveries d ON d.id = di.delivery_id
      JOIN articles a ON a.id = di.article_id
      JOIN markets m ON m.id = d.market_id
      WHERE d.driver_id=? AND d.date=? AND di.next_day_qty > 0
        AND m.is_large = 0
      GROUP BY a.id
      ORDER BY a.sort_order`, [driver.id, date]);

    // Large market next_day quantities — each large market gets its OWN column
    const largeMarkets = await db.allAsync(`
      SELECT DISTINCT m.id, m.name, m.portal_column_id
      FROM markets m
      JOIN deliveries d ON d.market_id = m.id
      WHERE d.driver_id = ? AND d.date = ? AND m.is_large = 1 AND m.active = 1`, [driver.id, date]);

    const largeMarketTasks = [];
    for (const lm of largeMarkets) {
      if (!lm.portal_column_id) continue;
      const lmItems = await db.allAsync(`
        SELECT a.code, a.external_code, a.name, a.sort_order,
               COALESCE(SUM(di.next_day_qty), 0) total_qty
        FROM delivery_items di
        JOIN deliveries d ON d.id = di.delivery_id
        JOIN articles a ON a.id = di.article_id
        WHERE d.driver_id=? AND d.market_id=? AND d.date=? AND di.next_day_qty > 0
        GROUP BY a.id
        ORDER BY a.sort_order`, [driver.id, lm.id, date]);
      if (lmItems.length > 0) {
        largeMarketTasks.push({
          driver: { ...driver, portal_column_id: lm.portal_column_id, name: lm.name },
          items: lmItems
        });
      }
    }

    if (normalItems.length > 0) {
      driverTasks.push({ driver, items: normalItems });
    } else {
      console.log(`[${new Date().toLocaleString('mk-MK')}] Account ${account.username}: Vozach ${driver.name} nema narachki za utre.`);
    }

    // Append large market tasks right after this driver's normal task
    driverTasks.push(...largeMarketTasks);
  }

  if (driverTasks.length === 0) {
    console.log(`[${new Date().toLocaleString('mk-MK')}] Account ${account.username}: Nema nitu eden vozach so narachki.`);
    return;
  }

  console.log(`[${new Date().toLocaleString('mk-MK')}] Account ${account.username}: Pronadjeni narachki za ${driverTasks.length} vozachi.`);

  return new Promise((resolve) => {
    // Fork a completely separate process for Chrome — isolated from Express's event loop
    const worker = fork(path.join(__dirname, 'orderWorker.js'), [], {
      env: process.env,
      silent: false   // Worker stdout/stderr flows directly to container logs
    });

    // Send the job to the worker
    worker.send({ account: { ...account, driverTasks }, date });

    let settled = false;
    function finish() {
      if (settled) return;
      settled = true;
      // Ensure the worker process is fully terminated
      try { worker.kill('SIGTERM'); } catch (_) {}
      // Give it 2 s to exit gracefully, then SIGKILL
      const forceKill = setTimeout(() => {
        try { worker.kill('SIGKILL'); } catch (_) {}
      }, 2000);
      worker.once('exit', () => clearTimeout(forceKill));
      resolve();
    }

    // Relay worker log messages to our console
    worker.on('message', (msg) => {
      const timePrefix = `[${new Date().toLocaleString('mk-MK')}]`;
      switch (msg.type) {
        case 'log':    console.log(`${timePrefix} ${msg.msg}`);    break;
        case 'warn':   console.warn(`${timePrefix} ${msg.msg}`);   break;
        case 'error':  console.error(`${timePrefix} ${msg.msg}`);  break;
        case 'done':
          console.log(`${timePrefix} [Worker] Account ${account.username}: done.`);
          finish();
          break;
        case 'failed':
          console.error(`${timePrefix} [Worker] Account ${account.username}: failed — ${msg.msg}`);
          finish();
          break;
      }
    });

    worker.on('error', (err) => {
      console.error(`Worker process error: ${err.message}`);
      finish();
    });

    worker.on('exit', (code, signal) => {
      if (!settled) {
        console.error(`Worker exited unexpectedly (code=${code}, signal=${signal})`);
        finish();
      }
    });
  });
}

// Keep the old function signature for individual test buttons in admin
async function submitOrdersForDriver(driver) {
  return enqueueAccount({
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

  // Use the queue so that concurrent cron triggers don't pile up
  for (const acc of accounts) {
    await enqueueAccount(acc);
    console.log('Pauza od 2 minuti pred sledniot account...');
    await new Promise(r => setTimeout(r, 120000));
  }
}

module.exports = { runAllOrders, submitOrdersForDriver, enqueueAccount };
