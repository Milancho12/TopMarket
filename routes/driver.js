const express = require('express');
const router = express.Router();
const { db } = require('../database');

function today() { return new Date().toISOString().split('T')[0]; }

// Driver home — supports ?date= query param
router.get('/', async (req, res) => {
  try {
    const driverId = req.session.user.id;
    const date = req.query.date || today();
    const isToday = date === today();

    // Markets from orders for chosen date
    const orderMarkets = await db.allAsync(`
      SELECT m.id, m.name, m.address, d.id del_id, d.submitted_at
      FROM orders o JOIN markets m ON m.id=o.market_id
      LEFT JOIN deliveries d ON d.driver_id=? AND d.market_id=m.id AND d.date=?
      WHERE o.driver_id=? AND o.date=? AND m.active=1 ORDER BY m.name`,
      [driverId, date, driverId, date]);

    // Permanently assigned markets
    const permMarkets = await db.allAsync(`
      SELECT m.id, m.name, m.address, d.id del_id, d.submitted_at
      FROM driver_markets dm JOIN markets m ON m.id=dm.market_id
      LEFT JOIN deliveries d ON d.driver_id=? AND d.market_id=m.id AND d.date=?
      WHERE dm.driver_id=? AND m.active=1
      AND m.id NOT IN (SELECT market_id FROM orders WHERE driver_id=? AND date=?)
      ORDER BY m.name`,
      [driverId, date, driverId, driverId, date]);

    const assignedIds = new Set(orderMarkets.map(m => m.id));
    const assigned = [...orderMarkets, ...permMarkets.filter(m => !assignedIds.has(m.id))];

    // Extra deliveries (not in orders or permanent assignments)
    const extra = await db.allAsync(`
      SELECT m.id, m.name, m.address, d.id del_id, d.submitted_at
      FROM deliveries d JOIN markets m ON m.id=d.market_id
      WHERE d.driver_id=? AND d.date=?
      AND m.id NOT IN (SELECT market_id FROM orders WHERE driver_id=? AND date=?)
      AND m.id NOT IN (SELECT market_id FROM driver_markets WHERE driver_id=?)
      ORDER BY m.name`,
      [driverId, date, driverId, date, driverId]);

    const allMarkets = await db.allAsync('SELECT id,name FROM markets WHERE active=1 ORDER BY name');
    res.render('driver/home', { date, isToday, assigned, extra, allMarkets });
  } catch(e) { res.status(500).send(e.message); }
});

// Tomorrow orders summary — supports ?date= (which date's next_day entries to show)
router.get('/tomorrow-orders', async (req, res) => {
  try {
    const driverId = req.session.user.id;
    const date = req.query.date || today();

    // Aggregate next_day_qty across all markets for this driver on chosen date
    const items = await db.allAsync(`
      SELECT a.code, a.name, a.sort_order,
             COALESCE(SUM(di.next_day_qty), 0) total_qty
      FROM delivery_items di
      JOIN deliveries d ON d.id = di.delivery_id
      JOIN articles a ON a.id = di.article_id
      WHERE d.driver_id=? AND d.date=? AND di.next_day_qty > 0
      GROUP BY a.id
      ORDER BY a.sort_order`, [driverId, date]);

    // Also get per-market breakdown
    const byMarket = await db.allAsync(`
      SELECT m.name market_name, a.code, a.name art_name, di.next_day_qty
      FROM delivery_items di
      JOIN deliveries d ON d.id = di.delivery_id
      JOIN articles a ON a.id = di.article_id
      JOIN markets m ON m.id = d.market_id
      WHERE d.driver_id=? AND d.date=? AND di.next_day_qty > 0
      ORDER BY m.name, a.sort_order`, [driverId, date]);

    res.render('driver/tomorrow-orders', { date, items, byMarket });
  } catch(e) { res.status(500).send(e.message); }
});

// Market delivery page — supports ?date= query param
router.get('/market/:marketId', async (req, res) => {
  try {
    const driverId = req.session.user.id;
    const { marketId } = req.params;
    const date = req.query.date || today();
    const isToday = date === today();

    const market = await db.getAsync('SELECT * FROM markets WHERE id=? AND active=1', [marketId]);
    if (!market) return res.redirect('/driver');

    const articles = await db.allAsync('SELECT * FROM articles WHERE active=1 ORDER BY sort_order');
    const delivery = await db.getAsync('SELECT * FROM deliveries WHERE driver_id=? AND market_id=? AND date=?', [driverId, marketId, date]);

    const itemsMap = {};
    if (delivery) {
      const rows = await db.allAsync('SELECT * FROM delivery_items WHERE delivery_id=?', [delivery.id]);
      rows.forEach(r => { itemsMap[r.article_id] = r; });
    }

    // Pre-fill delivered from previous day's next_day_qty (only when opening today with no delivery yet)
    const nextDayMap = {};
    if (!delivery && isToday) {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const yDate = yesterday.toISOString().split('T')[0];
      const yDelivery = await db.getAsync('SELECT * FROM deliveries WHERE driver_id=? AND market_id=? AND date=?', [driverId, marketId, yDate]);
      if (yDelivery) {
        const yItems = await db.allAsync('SELECT * FROM delivery_items WHERE delivery_id=?', [yDelivery.id]);
        yItems.forEach(r => { if (r.next_day_qty > 0) nextDayMap[r.article_id] = r.next_day_qty; });
      }
    }

    res.render('driver/market', { market, date, isToday, articles, delivery, itemsMap, nextDayMap });
  } catch(e) { res.status(500).send(e.message); }
});

// Submit / update delivery (allows past dates)
router.post('/market/:marketId', async (req, res) => {
  try {
    const driverId = req.session.user.id;
    const { marketId } = req.params;
    const date = req.query.date || today();
    const now = new Date().toISOString();
    const { notes, items } = req.body;

    let delivery = await db.getAsync('SELECT * FROM deliveries WHERE driver_id=? AND market_id=? AND date=?', [driverId, marketId, date]);

    if (delivery && delivery.locked) return res.json({ success: false, error: 'Испораката е заклучена од администраторот' });

    if (!delivery) {
      const r = await db.runAsync('INSERT INTO deliveries (driver_id,market_id,date,submitted_at,notes) VALUES (?,?,?,?,?)', [driverId, marketId, date, now, notes||null]);
      delivery = { id: r.lastID };
    } else {
      await db.runAsync('UPDATE deliveries SET edited_at=?,notes=? WHERE id=?', [now, notes||null, delivery.id]);
    }

    if (items && typeof items === 'object') {
      for (const [aId, q] of Object.entries(items)) {
        const del = parseInt(q.delivered)||0;
        const ret = parseInt(q.returned)||0;
        const nxt = parseInt(q.next_day)||0;
        await db.runAsync(
          `INSERT INTO delivery_items (delivery_id,article_id,delivered_qty,returned_qty,next_day_qty) VALUES (?,?,?,?,?)
           ON CONFLICT(delivery_id,article_id) DO UPDATE SET delivered_qty=excluded.delivered_qty, returned_qty=excluded.returned_qty, next_day_qty=excluded.next_day_qty`,
          [delivery.id, parseInt(aId), del, ret, nxt]);
      }
    }

    res.json({ success: true });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

module.exports = router;
