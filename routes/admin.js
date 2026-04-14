const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { db } = require('../database');
const { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType } = require('docx');

function today() { return new Date().toISOString().split('T')[0]; }

// ── PAGES ──────────────────────────────────────────────────

router.get('/', async (req, res) => {
  try {
    const date = req.query.date || today();
    const stats = {
      deliveries: (await db.getAsync('SELECT COUNT(*) c FROM deliveries WHERE date=?', [date])).c,
      delivered: (await db.getAsync('SELECT COALESCE(SUM(di.delivered_qty),0) c FROM delivery_items di JOIN deliveries d ON d.id=di.delivery_id WHERE d.date=?', [date])).c,
      returned: (await db.getAsync('SELECT COALESCE(SUM(di.returned_qty),0) c FROM delivery_items di JOIN deliveries d ON d.id=di.delivery_id WHERE d.date=?', [date])).c,
      markets: (await db.getAsync('SELECT COUNT(*) c FROM markets WHERE active=1')).c,
      drivers: (await db.getAsync("SELECT COUNT(*) c FROM users WHERE role='driver' AND active=1")).c,
    };
    const recent = await db.allAsync(`
      SELECT d.id, d.date, d.submitted_at, d.edited_at, u.name driver_name, m.name market_name,
             COALESCE(SUM(di.delivered_qty),0) tot_del, COALESCE(SUM(di.returned_qty),0) tot_ret
      FROM deliveries d JOIN users u ON u.id=d.driver_id JOIN markets m ON m.id=d.market_id
      LEFT JOIN delivery_items di ON di.delivery_id=d.id WHERE d.date=?
      GROUP BY d.id ORDER BY d.submitted_at DESC`, [date]);
    res.render('admin/dashboard', { stats, recent, date });
  } catch (e) { res.status(500).send(e.message); }
});

router.get('/settings', async (req, res) => {
  try {
    const admin = await db.getAsync('SELECT * FROM users WHERE id=?', [req.session.user.id]);
    res.render('admin/settings', { admin, error: null, success: null });
  } catch (e) { res.status(500).send(e.message); }
});

router.post('/settings', async (req, res) => {
  try {
    const { username, password } = req.body;
    let successMsg = null;
    let errorMsg = null;

    if (!username) {
      errorMsg = 'Корисничкото име е задолжително';
    } else {
      const existing = await db.getAsync('SELECT id FROM users WHERE username=? AND id!=?', [username, req.session.user.id]);
      if (existing) {
        errorMsg = 'Корисничкото име е веќе зафатено';
      } else {
        if (password && password.trim() !== '') {
          const hash = await bcrypt.hash(password, 10);
          await db.runAsync('UPDATE users SET username=?, password=? WHERE id=?', [username, hash, req.session.user.id]);
          successMsg = 'Корисничкото име и лозинката се успешно променети!';
        } else {
          await db.runAsync('UPDATE users SET username=? WHERE id=?', [username, req.session.user.id]);
          successMsg = 'Корисничкото име е успешно променето!';
        }
      }
    }
    const admin = await db.getAsync('SELECT * FROM users WHERE id=?', [req.session.user.id]);
    res.render('admin/settings', { admin, error: errorMsg, success: successMsg });
  } catch (e) {
    const admin = await db.getAsync('SELECT * FROM users WHERE id=?', [req.session.user.id]);
    res.render('admin/settings', { admin, error: e.message, success: null });
  }
});

router.get('/markets', async (req, res) => {
  const markets = await db.allAsync('SELECT * FROM markets WHERE active=1 ORDER BY name');
  res.render('admin/markets', { markets });
});

router.get('/articles', async (req, res) => {
  const articles = await db.allAsync('SELECT * FROM articles WHERE active=1 ORDER BY sort_order');
  res.render('admin/articles', { articles });
});

router.get('/drivers', async (req, res) => {
  const drivers = await db.allAsync("SELECT id,name,username,phone,active FROM users WHERE role='driver' ORDER BY name");
  const markets = await db.allAsync('SELECT id,name FROM markets WHERE active=1 ORDER BY name');
  res.render('admin/drivers', { drivers, markets });
});

router.get('/orders', async (req, res) => {
  const date = req.query.date || today();
  const drivers = await db.allAsync("SELECT id,name FROM users WHERE role='driver' AND active=1 ORDER BY name");
  const markets = await db.allAsync('SELECT id,name FROM markets WHERE active=1 ORDER BY name');
  const orders = await db.allAsync(`
    SELECT o.id, o.driver_id, o.market_id, u.name driver_name, m.name market_name, d.submitted_at
    FROM orders o JOIN users u ON u.id=o.driver_id JOIN markets m ON m.id=o.market_id
    LEFT JOIN deliveries d ON d.driver_id=o.driver_id AND d.market_id=o.market_id AND d.date=o.date
    WHERE o.date=? ORDER BY u.name, m.name`, [date]);
  res.render('admin/orders', { date, drivers, markets, orders });
});

router.get('/reports', async (req, res) => {
  const t = today();
  const f = { date_from: req.query.date_from || t, date_to: req.query.date_to || t, driver_id: req.query.driver_id || '', market_id: req.query.market_id || '' };
  const drivers = await db.allAsync("SELECT id,name FROM users WHERE role='driver' ORDER BY name");
  const markets = await db.allAsync('SELECT id,name FROM markets ORDER BY name');
  let q = `SELECT d.id, d.date, d.submitted_at, d.edited_at, d.notes, u.name driver_name, m.name market_name,
           COALESCE(SUM(di.delivered_qty),0) tot_del, COALESCE(SUM(di.returned_qty),0) tot_ret
    FROM deliveries d JOIN users u ON u.id=d.driver_id JOIN markets m ON m.id=d.market_id
    LEFT JOIN delivery_items di ON di.delivery_id=d.id WHERE 1=1`;
  const params = [];
  if (f.date_from) { q += ' AND d.date>=?'; params.push(f.date_from); }
  if (f.date_to) { q += ' AND d.date<=?'; params.push(f.date_to); }
  if (f.driver_id) { q += ' AND d.driver_id=?'; params.push(f.driver_id); }
  if (f.market_id) { q += ' AND d.market_id=?'; params.push(f.market_id); }
  q += ' GROUP BY d.id ORDER BY d.date DESC, d.submitted_at DESC LIMIT 500';
  const deliveries = await db.allAsync(q, params);
  res.render('admin/reports', { deliveries, drivers, markets, filters: f });
});

// ── WORD DOCUMENT EXPORT ──────────────────────────────────

router.get('/reports/word', async (req, res) => {
  try {
    const { date_from, date_to, market_id } = req.query;
    if (!date_from || !date_to) return res.status(400).send('Датумите се задолжителни');

    let marketsToExport;
    if (market_id) {
      marketsToExport = await db.allAsync('SELECT * FROM markets WHERE id=?', [market_id]);
    } else {
      marketsToExport = await db.allAsync('SELECT * FROM markets WHERE active=1 ORDER BY name');
    }

    const children = [];

    for (const market of marketsToExport) {
      const rows = await db.allAsync(`
        SELECT a.code, a.name, a.price,
               COALESCE(SUM(di.delivered_qty),0) tot_del,
               COALESCE(SUM(di.returned_qty),0)  tot_ret,
               COALESCE(SUM(di.delivered_qty - di.returned_qty),0) net_qty
        FROM delivery_items di
        JOIN deliveries d ON d.id = di.delivery_id
        JOIN articles a ON a.id = di.article_id
        WHERE d.market_id=? AND d.date>=? AND d.date<=?
        GROUP BY a.id
        HAVING net_qty > 0
        ORDER BY a.sort_order`, [market.id, date_from, date_to]);

      if (rows.length === 0) continue;

      const totalPrice = rows.reduce((sum, r) => sum + (r.net_qty * r.price), 0);

      // Market name heading (bold, larger)
      children.push(new Paragraph({
        children: [new TextRun({ text: market.name, bold: true, size: 36, color: '1a1a2e' })],
        spacing: { before: 480, after: 240 },
      }));

      // Separator line paragraph
      children.push(new Paragraph({
        children: [new TextRun({ text: '─'.repeat(40), color: '888888', size: 18 })],
        spacing: { before: 0, after: 120 },
      }));

      // Product rows: code - net_qty
      for (const r of rows) {
        children.push(new Paragraph({
          children: [
            new TextRun({ text: `${r.code}`, bold: true, size: 24 }),
            new TextRun({ text: ` - ${r.net_qty}`, size: 24 }),
          ],
          spacing: { after: 80 },
        }));
      }

      // Total price line
      children.push(new Paragraph({
        children: [
          new TextRun({ text: `Вкупен износ: ${Math.round(totalPrice)} ден.`, bold: true, size: 28, color: '1d4ed8' }),
        ],
        spacing: { before: 200, after: 480 },
      }));
    }

    if (children.length === 0) {
      return res.status(404).send('Нема податоци за избраниот период');
    }

    const doc = new Document({
      creator: 'ZitoLuks',
      title: `Извештај ${date_from} – ${date_to}`,
      sections: [{ children }],
    });

    const buffer = await Packer.toBuffer(doc);
    const fname = `Izvestaj_${date_from}_${date_to}.docx`;

    res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.set('Content-Disposition', `attachment; filename="${fname}"`);
    res.set('Content-Length', buffer.length);
    res.end(buffer);
  } catch (e) { console.error(e); res.status(500).send(e.message); }
});


router.get('/invoices', async (req, res) => {
  const t = today();
  const markets = await db.allAsync('SELECT id,name FROM markets WHERE active=1 ORDER BY name');
  const f = { market_id: req.query.market_id || '', date_from: req.query.date_from || t, date_to: req.query.date_to || t };
  let invoiceData = null, selMarket = null;
  if (f.market_id && f.date_from && f.date_to) {
    selMarket = await db.getAsync('SELECT * FROM markets WHERE id=?', [f.market_id]);
    const rows = await db.allAsync(`
      SELECT a.code, a.name, a.price, a.unit,
             SUM(di.delivered_qty) tot_del, SUM(di.returned_qty) tot_ret,
             SUM(di.delivered_qty - di.returned_qty) net_qty
      FROM delivery_items di JOIN deliveries d ON d.id=di.delivery_id JOIN articles a ON a.id=di.article_id
      WHERE d.market_id=? AND d.date>=? AND d.date<=?
      GROUP BY a.id HAVING net_qty>0 ORDER BY a.sort_order`, [f.market_id, f.date_from, f.date_to]);
    invoiceData = rows.map(r => ({ ...r, total: r.net_qty * r.price }));
  }
  res.render('admin/invoices', { markets, invoiceData, selMarket, filters: f });
});

// ── API: MARKETS ──────────────────────────────────────────

router.post('/api/markets', async (req, res) => {
  try {
    const { name, address, contact_name, contact_phone } = req.body;
    if (!name) return res.json({ success: false, error: 'Назив е задолжителен' });
    const r = await db.runAsync('INSERT INTO markets (name,address,contact_name,contact_phone) VALUES (?,?,?,?)', [name, address || null, contact_name || null, contact_phone || null]);
    res.json({ success: true, id: r.lastID });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

router.put('/api/markets/:id', async (req, res) => {
  try {
    const { name, address, contact_name, contact_phone } = req.body;
    await db.runAsync('UPDATE markets SET name=?,address=?,contact_name=?,contact_phone=? WHERE id=?', [name, address || null, contact_name || null, contact_phone || null, req.params.id]);
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

router.delete('/api/markets/:id', async (req, res) => {
  try { await db.runAsync('UPDATE markets SET active=0 WHERE id=?', [req.params.id]); res.json({ success: true }); }
  catch (e) { res.json({ success: false, error: e.message }); }
});

// ── API: ARTICLES ─────────────────────────────────────────

router.post('/api/articles', async (req, res) => {
  try {
    const { code, name, price, unit } = req.body;
    if (!name) return res.json({ success: false, error: 'Назив е задолжителен' });
    const mx = await db.getAsync('SELECT MAX(sort_order) mo FROM articles WHERE active=1');
    const r = await db.runAsync('INSERT INTO articles (code,name,price,unit,sort_order) VALUES (?,?,?,?,?)', [code || '', name, parseFloat(price) || 0, unit || 'kom', (mx.mo || 0) + 1]);
    res.json({ success: true, id: r.lastID });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

router.put('/api/articles/:id', async (req, res) => {
  try {
    const { code, name, price, unit } = req.body;
    await db.runAsync('UPDATE articles SET code=?,name=?,price=?,unit=? WHERE id=?', [code || '', name, parseFloat(price) || 0, unit || 'kom', req.params.id]);
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

router.delete('/api/articles/:id', async (req, res) => {
  try { await db.runAsync('UPDATE articles SET active=0 WHERE id=?', [req.params.id]); res.json({ success: true }); }
  catch (e) { res.json({ success: false, error: e.message }); }
});

router.post('/api/articles/:id/move', async (req, res) => {
  try {
    const { direction } = req.body;
    const art = await db.getAsync('SELECT * FROM articles WHERE id=? AND active=1', [req.params.id]);
    if (!art) return res.json({ success: false, error: 'Не е пронајден' });
    const swap = direction === 'up'
      ? await db.getAsync('SELECT * FROM articles WHERE sort_order<? AND active=1 ORDER BY sort_order DESC LIMIT 1', [art.sort_order])
      : await db.getAsync('SELECT * FROM articles WHERE sort_order>? AND active=1 ORDER BY sort_order ASC LIMIT 1', [art.sort_order]);
    if (!swap) return res.json({ success: false, error: 'Не може' });
    await db.runAsync('UPDATE articles SET sort_order=? WHERE id=?', [swap.sort_order, art.id]);
    await db.runAsync('UPDATE articles SET sort_order=? WHERE id=?', [art.sort_order, swap.id]);
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// ── API: DRIVERS ──────────────────────────────────────────

router.post('/api/drivers', async (req, res) => {
  try {
    const { name, username, password, phone } = req.body;
    if (!name || !username || !password) return res.json({ success: false, error: 'Сите полиња се задолжителни' });
    const hash = bcrypt.hashSync(password, 10);
    const r = await db.runAsync("INSERT INTO users (name,username,password,role,phone) VALUES (?,?,?,'driver',?)", [name, username, hash, phone || null]);
    res.json({ success: true, id: r.lastID });
  } catch (e) {
    res.json({ success: false, error: e.message.includes('UNIQUE') ? 'Корисничкото ime веќе постои' : e.message });
  }
});

router.put('/api/drivers/:id', async (req, res) => {
  try {
    const { name, username, password, phone, active } = req.body;
    if (password) {
      const hash = bcrypt.hashSync(password, 10);
      await db.runAsync("UPDATE users SET name=?,username=?,password=?,phone=?,active=? WHERE id=? AND role='driver'", [name, username, hash, phone || null, active ? 1 : 0, req.params.id]);
    } else {
      await db.runAsync("UPDATE users SET name=?,username=?,phone=?,active=? WHERE id=? AND role='driver'", [name, username, phone || null, active ? 1 : 0, req.params.id]);
    }
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// ── API: ORDERS ───────────────────────────────────────────

router.get('/api/orders', async (req, res) => {
  const { date, driver_id } = req.query;
  const rows = await db.allAsync('SELECT o.id, o.market_id, m.name market_name FROM orders o JOIN markets m ON m.id=o.market_id WHERE o.date=? AND o.driver_id=? ORDER BY m.name', [date, driver_id]);
  res.json(rows);
});

router.post('/api/orders', async (req, res) => {
  try {
    const { driver_id, market_id, date } = req.body;
    await db.runAsync('INSERT OR IGNORE INTO orders (driver_id,market_id,date) VALUES (?,?,?)', [driver_id, market_id, date]);
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

router.delete('/api/orders/:id', async (req, res) => {
  try { await db.runAsync('DELETE FROM orders WHERE id=?', [req.params.id]); res.json({ success: true }); }
  catch (e) { res.json({ success: false, error: e.message }); }
});

// ── API: REPORT DETAIL ────────────────────────────────────

router.get('/api/reports/:id', async (req, res) => {
  const delivery = await db.getAsync('SELECT d.*, u.name driver_name, m.name market_name FROM deliveries d JOIN users u ON u.id=d.driver_id JOIN markets m ON m.id=d.market_id WHERE d.id=?', [req.params.id]);
  if (!delivery) return res.json({ error: 'Not found' });
  const items = await db.allAsync('SELECT di.*, a.name article_name, a.code, a.price, a.unit FROM delivery_items di JOIN articles a ON a.id=di.article_id WHERE di.delivery_id=? ORDER BY a.sort_order', [req.params.id]);
  res.json({ delivery, items });
});

router.delete('/api/reports/:id', async (req, res) => {
  try {
    // delivery_items deleted automatically via ON DELETE CASCADE
    await db.runAsync('DELETE FROM deliveries WHERE id=?', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// ── API: DRIVER MARKETS (permanent assignments) ───────────

router.get('/api/driver-markets/:driverId', async (req, res) => {
  try {
    const rows = await db.allAsync(`
      SELECT dm.id, m.id market_id, m.name market_name
      FROM driver_markets dm JOIN markets m ON m.id=dm.market_id
      WHERE dm.driver_id=? ORDER BY m.name`, [req.params.driverId]);
    res.json(rows);
  } catch (e) { res.json({ error: e.message }); }
});

router.post('/api/driver-markets', async (req, res) => {
  try {
    const { driver_id, market_id } = req.body;
    await db.runAsync('INSERT OR IGNORE INTO driver_markets (driver_id,market_id) VALUES (?,?)', [driver_id, market_id]);
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

router.delete('/api/driver-markets/:id', async (req, res) => {
  try { await db.runAsync('DELETE FROM driver_markets WHERE id=?', [req.params.id]); res.json({ success: true }); }
  catch (e) { res.json({ success: false, error: e.message }); }
});

module.exports = router;
