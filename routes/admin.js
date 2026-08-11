const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { db } = require('../database');
const { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType } = require('docx');
const ExcelJS = require('exceljs');

const DISTRIBUTER_CODE = '300189';

// Shared bread product groups used in multiple reports
const BREAD_GROUPS = {
  sekojedneven: { label: 'Секојдневен леб', codes: ['94', '868', '430', '725', '814'] },
  specijalen: { label: 'Специјален леб', codes: ['737', '738', '770', '644', '643', '870', '806'] },
  tost: { label: 'Тост леб', codes: ['89', '90', '641', '642', '669', '417', '418', '948', '949', '723', '778'] },
};

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

// ── PAGES ──────────────────────────────────────────────────

router.get('/', async (req, res) => {
  try {
    const date = req.query.date || today();
    const stats = {
      deliveries: (await db.getAsync('SELECT COUNT(*) c FROM deliveries d JOIN markets m ON m.id=d.market_id WHERE d.date=? AND m.is_large=0', [date])).c,
      delivered: (await db.getAsync('SELECT COALESCE(SUM(di.delivered_qty),0) c FROM delivery_items di JOIN deliveries d ON d.id=di.delivery_id JOIN markets m ON m.id=d.market_id WHERE d.date=? AND m.is_large=0', [date])).c,
      returned: (await db.getAsync('SELECT COALESCE(SUM(di.returned_qty),0) c FROM delivery_items di JOIN deliveries d ON d.id=di.delivery_id JOIN markets m ON m.id=d.market_id WHERE d.date=? AND m.is_large=0', [date])).c,
      markets: (await db.getAsync('SELECT COUNT(*) c FROM markets WHERE active=1 AND is_large=0')).c,
      drivers: (await db.getAsync("SELECT COUNT(*) c FROM users WHERE role='driver' AND active=1")).c,
    };
    const recent = await db.allAsync(`
      SELECT d.id, d.date, d.submitted_at, d.edited_at, u.name driver_name, m.name market_name,
             COALESCE(SUM(di.delivered_qty),0) tot_del, COALESCE(SUM(di.returned_qty),0) tot_ret
      FROM deliveries d JOIN users u ON u.id=d.driver_id JOIN markets m ON m.id=d.market_id
      LEFT JOIN delivery_items di ON di.delivery_id=d.id WHERE d.date=? AND m.is_large=0
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
  const markets = await db.allAsync('SELECT m.*, c.name company_name FROM markets m LEFT JOIN companies c ON c.id=m.company_id WHERE m.active=1 ORDER BY m.is_large, m.name');
  const companies = await db.allAsync('SELECT id,name FROM companies WHERE active=1 ORDER BY name');
  const allArticles = await db.allAsync('SELECT id,code,name,is_market_article FROM articles WHERE active=1 ORDER BY is_market_article, sort_order');
  res.render('admin/markets', { markets, companies, allArticles });
});

router.get('/articles', async (req, res) => {
  const articles = await db.allAsync('SELECT * FROM articles WHERE active=1 ORDER BY sort_order');
  res.render('admin/articles', { articles });
});

router.get('/drivers', async (req, res) => {
  const drivers = await db.allAsync("SELECT id,name,username,phone,active,portal_username,portal_password,portal_column_id FROM users WHERE role='driver' ORDER BY name");
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
  const f = { date_from: req.query.date_from || t, date_to: req.query.date_to || t, driver_id: req.query.driver_id || '', market_id: req.query.market_id || '', company_id: req.query.company_id || '' };
  const drivers = await db.allAsync("SELECT id,name FROM users WHERE role='driver' ORDER BY name");
  const markets = await db.allAsync('SELECT id, name, company_id FROM markets WHERE is_large=0 ORDER BY name');
  const companies = await db.allAsync('SELECT id,name FROM companies WHERE active=1 ORDER BY name');
  let q = `SELECT d.id, d.date, d.submitted_at, d.edited_at, d.notes, u.name driver_name, m.name market_name,
           COALESCE(SUM(di.delivered_qty),0) tot_del, COALESCE(SUM(di.returned_qty),0) tot_ret
    FROM deliveries d JOIN users u ON u.id=d.driver_id JOIN markets m ON m.id=d.market_id
    LEFT JOIN delivery_items di ON di.delivery_id=d.id WHERE m.is_large=0`;

  let tQ = `SELECT COALESCE(SUM(di.delivered_qty),0) g_del, COALESCE(SUM(di.returned_qty),0) g_ret
            FROM deliveries d JOIN markets m ON m.id=d.market_id
            LEFT JOIN delivery_items di ON di.delivery_id=d.id WHERE m.is_large=0`;

  const params = [];
  if (f.date_from) { q += ' AND d.date>=?'; tQ += ' AND d.date>=?'; params.push(f.date_from); }
  if (f.date_to) { q += ' AND d.date<=?'; tQ += ' AND d.date<=?'; params.push(f.date_to); }
  if (f.driver_id) { q += ' AND d.driver_id=?'; tQ += ' AND d.driver_id=?'; params.push(f.driver_id); }
  if (f.market_id) { q += ' AND d.market_id=?'; tQ += ' AND d.market_id=?'; params.push(f.market_id); }
  if (f.company_id) { q += ' AND m.company_id=?'; tQ += ' AND m.company_id=?'; params.push(f.company_id); }
  q += ' GROUP BY d.id ORDER BY d.date DESC, d.submitted_at DESC LIMIT 500';

  const deliveries = await db.allAsync(q, params);
  const totals = await db.getAsync(tQ, params);

  res.render('admin/reports', { deliveries, totals, drivers, markets, companies, filters: f });
});

// ── WORD DOCUMENT EXPORT ──────────────────────────────────

router.get('/reports/word', async (req, res) => {
  try {
    const { date_from, date_to, market_id, company_id } = req.query;
    if (!date_from || !date_to) return res.status(400).send('Датумите се задолжителни');

    const children = [];

    if (company_id && !market_id) {
      const comp = await db.getAsync('SELECT * FROM companies WHERE id=?', [company_id]);
      const rows = await db.allAsync(`
        SELECT a.code, a.name, a.price, a.sort_order,
               COALESCE(SUM(di.delivered_qty),0) tot_del,
               COALESCE(SUM(di.returned_qty),0)  tot_ret,
               COALESCE(SUM(di.delivered_qty - di.returned_qty),0) net_qty
        FROM delivery_items di
        JOIN deliveries d ON d.id = di.delivery_id
        JOIN articles a ON a.id = di.article_id
        JOIN markets m ON m.id = d.market_id
        WHERE m.company_id=? AND d.date>=? AND d.date<=? AND m.is_large=0
        GROUP BY a.id
        HAVING net_qty > 0
        ORDER BY a.sort_order`, [company_id, date_from, date_to]);

      if (rows.length > 0) {
        const totalPrice = rows.reduce((sum, r) => sum + (r.net_qty * r.price), 0);
        children.push(new Paragraph({
          children: [new TextRun({ text: `ЗБИРНО ЗА ФИРМА: ${comp.name}`, bold: true, size: 36, color: '1a1a2e' })],
          spacing: { before: 480, after: 240 },
        }));
        children.push(new Paragraph({
          children: [new TextRun({ text: '─'.repeat(40), color: '888888', size: 18 })],
          spacing: { before: 0, after: 120 },
        }));
        for (const r of rows) {
          children.push(new Paragraph({
            children: [
              new TextRun({ text: `${r.code}`, bold: true, size: 24 }),
              new TextRun({ text: ` - ${r.net_qty}`, size: 24 }),
            ],
            spacing: { after: 80 },
          }));
        }
        children.push(new Paragraph({
          children: [
            new TextRun({ text: `Вкупен износ: ${Math.round(totalPrice)} ден.`, bold: true, size: 28, color: '1d4ed8' }),
          ],
          spacing: { before: 200, after: 480 },
        }));
      }
    } else {
      let marketsToExport;
      if (market_id) {
        marketsToExport = await db.allAsync('SELECT * FROM markets WHERE id=? AND is_large=0', [market_id]);
      } else {
        marketsToExport = await db.allAsync('SELECT * FROM markets WHERE active=1 AND is_large=0 ORDER BY name');
      }

      for (const market of marketsToExport) {
        const rows = await db.allAsync(`
          SELECT a.code, a.name, a.price, a.sort_order,
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

        const marketHeading = market.client_code ? `${market.client_code} – ${market.name}` : market.name;

        if (rows.length === 0) continue;

        const totalPrice = rows.reduce((sum, r) => sum + (r.net_qty * r.price), 0);

        children.push(new Paragraph({
          children: [new TextRun({ text: marketHeading, bold: true, size: 36, color: '1a1a2e' })],
          spacing: { before: 480, after: 240 },
        }));

        children.push(new Paragraph({
          children: [new TextRun({ text: '─'.repeat(40), color: '888888', size: 18 })],
          spacing: { before: 0, after: 120 },
        }));

        for (const r of rows) {
          children.push(new Paragraph({
            children: [
              new TextRun({ text: `${r.code}`, bold: true, size: 24 }),
              new TextRun({ text: ` - ${r.net_qty}`, size: 24 }),
            ],
            spacing: { after: 80 },
          }));
        }

        children.push(new Paragraph({
          children: [
            new TextRun({ text: `Вкупен износ: ${Math.round(totalPrice)} ден.`, bold: true, size: 28, color: '1d4ed8' }),
          ],
          spacing: { before: 200, after: 480 },
        }));
      }
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
  const markets = await db.allAsync('SELECT id,name FROM markets WHERE active=1 AND is_large=0 ORDER BY name');
  const f = { market_id: req.query.market_id || '', date_from: req.query.date_from || t, date_to: req.query.date_to || t };
  let invoiceData = null, selMarket = null;
  if (f.market_id && f.date_from && f.date_to) {
    selMarket = await db.getAsync('SELECT * FROM markets WHERE id=? AND is_large=0', [f.market_id]);
    if (!selMarket) return res.render('admin/invoices', { markets, invoiceData: null, selMarket: null, filters: f });
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

// ── ZITO LUKS EXCEL REPORT ────────────────────────────────
router.get('/zito-report', async (req, res) => {
  try {
    const t = today();
    const drivers = await db.allAsync("SELECT id,name FROM users WHERE role='driver' ORDER BY name");
    const markets = await db.allAsync('SELECT id, name, company_id FROM markets WHERE active=1 AND is_large=0 ORDER BY name');
    const companies = await db.allAsync('SELECT id,name FROM companies WHERE active=1 ORDER BY name');
    const f = { date_from: req.query.date_from || t, date_to: req.query.date_to || t, driver_id: req.query.driver_id || '', market_id: req.query.market_id || '', company_id: req.query.company_id || '' };
    res.render('admin/zito-report', { drivers, markets, companies, filters: f });
  } catch (e) { res.status(500).send(e.message); }
});

router.get('/zito-report/excel', async (req, res) => {
  try {
    const { date_from, date_to, driver_id, market_id, company_id } = req.query;
    if (!date_from || !date_to) return res.status(400).send('Датумите се задолжителни');

    let sql = '';
    const params = [date_from, date_to];

    if (company_id && !market_id) {
      sql = `
         SELECT c.id as market_id, c.name as market_name, '' as market_city, '' as market_address,
                '' as client_code, '' as object_code,
                a.code art_code, a.name art_name, a.price,
                SUM(di.delivered_qty) delivered_qty,
                SUM(di.returned_qty) returned_qty,
                SUM(di.delivered_qty - di.returned_qty) net_qty
         FROM delivery_items di
         JOIN deliveries d ON d.id = di.delivery_id
         JOIN articles a ON a.id = di.article_id
         JOIN markets m ON m.id = d.market_id
         JOIN companies c ON c.id = m.company_id
         WHERE d.date>=? AND d.date<=? AND m.company_id=? AND m.is_large=0
       `;
      params.push(company_id);
      if (driver_id) { sql += ' AND d.driver_id=?'; params.push(driver_id); }
      sql += ' GROUP BY c.id, a.id HAVING net_qty > 0 ORDER BY c.name, a.sort_order';
    } else {
      sql = `
         SELECT m.id market_id, m.name market_name, m.city market_city, m.address market_address,
                m.client_code, m.object_code,
                a.code art_code, a.name art_name, a.price,
                SUM(di.delivered_qty) delivered_qty,
                SUM(di.returned_qty) returned_qty,
                SUM(di.delivered_qty - di.returned_qty) net_qty
         FROM delivery_items di
         JOIN deliveries d ON d.id = di.delivery_id
         JOIN articles a ON a.id = di.article_id
         JOIN markets m ON m.id = d.market_id
         WHERE d.date>=? AND d.date<=? AND m.is_large=0`;
      if (driver_id) { sql += ' AND d.driver_id=?'; params.push(driver_id); }
      if (market_id) { sql += ' AND d.market_id=?'; params.push(market_id); }
      sql += ' GROUP BY m.id, a.id HAVING net_qty > 0 ORDER BY m.name, a.sort_order';
    }

    const rows = await db.allAsync(sql, params);
    const dateStr = date_from === date_to ? date_from : `${date_from} do ${date_to}`;

    const wb = new ExcelJS.Workbook();
    wb.creator = 'ZitoLuks';
    const ws = wb.addWorksheet('ZitoLuks Извештај', { views: [{ state: 'frozen', ySplit: 2 }] });

    // Column widths
    ws.columns = [
      { width: 14 }, // A  DISTRIBUTER
      { width: 12 }, // B  DATUM
      { width: 12 }, // C  KLIENT SIFRA
      { width: 22 }, // D  KLIENT OPIS
      { width: 12 }, // E  OBJEKT SIFRA
      { width: 14 }, // F  OBJEKT GRAD
      { width: 24 }, // G  OBJEKT ADRESA
      { width: 14 }, // H  PROIZVOD SIFRA
      { width: 28 }, // I  PROIZVOD OPIS
      { width: 11 }, // J  BRUTO KOL
      { width: 12 }, // K  VRATENO KOL
      { width: 10 }, // L  NETO KOL
      { width: 13 }, // M  BRUTO IZNOS
      { width: 14 }, // N  VRATENO IZNOS
      { width: 12 }, // O  NETO IZNOS
    ];

    // ── ROW 1: Group headers ──────────────────────────────
    const row1 = ws.getRow(1);

    // Color palette matching the image exactly
    const C = {
      orange: 'FFFFC000', // Sifra-distributer & Datum  (deep amber/orange)
      clientBg: 'FFFF8C00', // Podatoci za klientot       (dark orange)
      prodBg: 'FFFF6600', // Podatoci za Proizvod       (brick orange)
      greenBg: 'FF00B050', // Kolicini                   (Excel green)
      yellowBg: 'FFFFFF00', // Vrednost(Bez DDV)          (bright yellow)
    };

    const hStyle = (argbBg, argbFg = 'FF000000') => ({
      font: { bold: true, color: { argb: argbFg }, size: 10 },
      fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: argbBg } },
      alignment: { horizontal: 'center', vertical: 'middle', wrapText: true },
      border: {
        top: { style: 'medium', color: { argb: 'FF000000' } },
        left: { style: 'medium', color: { argb: 'FF000000' } },
        bottom: { style: 'medium', color: { argb: 'FF000000' } },
        right: { style: 'medium', color: { argb: 'FF000000' } },
      }
    });

    row1.height = 30;
    ws.mergeCells('A1:A2'); ws.getCell('A1').value = 'Sifra-distributer';
    Object.assign(ws.getCell('A1'), hStyle(C.orange));
    ws.mergeCells('B1:B2'); ws.getCell('B1').value = 'Datum';
    Object.assign(ws.getCell('B1'), hStyle(C.orange));
    ws.mergeCells('C1:G1'); ws.getCell('C1').value = 'Podatoci za klientot i objektot';
    Object.assign(ws.getCell('C1'), hStyle(C.clientBg));
    ws.mergeCells('H1:I1'); ws.getCell('H1').value = 'Podatoci za Proizvod';
    Object.assign(ws.getCell('H1'), hStyle(C.prodBg, 'FFFFFFFF'));
    ws.mergeCells('J1:L1'); ws.getCell('J1').value = 'Kolicini';
    Object.assign(ws.getCell('J1'), hStyle(C.greenBg, 'FFFFFFFF'));
    ws.mergeCells('M1:O1'); ws.getCell('M1').value = 'Vrednost(Bez DDV)';
    Object.assign(ws.getCell('M1'), hStyle(C.yellowBg));

    // ── ROW 2: Column names ───────────────────────────────
    const row2 = ws.getRow(2);
    row2.height = 34;
    const cols = ['DISTRIBUTER', 'DATUM', 'KLIENT SIFRA', 'KLIENT OPIS', 'OBJEKT SIFRA', 'OBJEKT GRAD', 'OBJEKT ADRESA',
      'PROIZVOD SIFRA', 'PROIZVOD OPIS', 'BRUTO KOL', 'VRATENO KOL', 'NETO KOL', 'BRUTO IZNOS', 'VRATENO IZNOS', 'NETO IZNOS'];
    const colBgs = [C.orange, C.orange, C.clientBg, C.clientBg, C.clientBg, C.clientBg, C.clientBg,
    C.prodBg, C.prodBg, C.greenBg, C.greenBg, C.greenBg, C.yellowBg, C.yellowBg, C.yellowBg];
    const colFgs = ['FF000000', 'FF000000', 'FF000000', 'FF000000', 'FF000000', 'FF000000', 'FF000000',
      'FFFFFFFF', 'FFFFFFFF', 'FFFFFFFF', 'FFFFFFFF', 'FFFFFFFF', 'FF000000', 'FF000000', 'FF000000'];
    cols.forEach((name, i) => {
      const cell = row2.getCell(i + 1);
      cell.value = name;
      cell.style = hStyle(colBgs[i], colFgs[i]);
    });

    let gDel = 0, gRet = 0, gNet = 0, gDelIznos = 0, gRetIznos = 0, gNetIznos = 0;

    // ── DATA ROWS ─────────────────────────────────────────
    const dataStyle = {
      font: { size: 10 },
      border: { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } },
      alignment: { vertical: 'middle' }
    };
    const numStyle = { ...dataStyle, alignment: { horizontal: 'right', vertical: 'middle' } };

    let currentMarketId = null;
    let rowIdx = 0; // Custom index to reset row shading per market

    rows.forEach((r) => {
      if (currentMarketId !== null && currentMarketId !== r.market_id) {
        for (let i = 0; i < 5; i++) ws.addRow([]); // Insert 5 empty rows between markets
        rowIdx = 0;
      }
      currentMarketId = r.market_id;

      const delIznos = r.delivered_qty * r.price;
      const retIznos = r.returned_qty * r.price;
      const netIznos = r.net_qty * r.price;

      gDel += r.delivered_qty;
      gRet += r.returned_qty;
      gNet += r.net_qty;
      gDelIznos += delIznos;
      gRetIznos += retIznos;
      gNetIznos += netIznos;

      const row = ws.addRow([
        DISTRIBUTER_CODE,
        dateStr,
        r.client_code || '',
        r.market_name || '',
        r.object_code || '',
        r.market_city || '',
        r.market_address || '',
        r.art_code,
        r.art_name,
        r.delivered_qty,
        r.returned_qty,
        r.net_qty,
        parseFloat((r.delivered_qty * r.price).toFixed(2)),
        parseFloat((r.returned_qty * r.price).toFixed(2)),
        parseFloat((r.net_qty * r.price).toFixed(2)),
      ]);
      row.height = 18;
      row.eachCell({ includeEmpty: true }, (cell, colNum) => {
        cell.style = colNum >= 10 ? numStyle : dataStyle;
        // Alternate row shading
        if (rowIdx % 2 === 1) {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF5F5F5' } };
        }
      });
      rowIdx++;
    });

    if (rows.length > 0) {
      ws.addRow([]);

      const grandTotalRow = ws.addRow([
        '', '', '', '', '', '', '', '', 'ВКУПНО:',
        gDel, gRet, gNet,
        parseFloat(gDelIznos.toFixed(2)), parseFloat(gRetIznos.toFixed(2)), parseFloat(gNetIznos.toFixed(2))
      ]);
      grandTotalRow.height = 20;
      grandTotalRow.eachCell({ includeEmpty: true }, (cell, colNum) => {
        if (colNum >= 9) {
          cell.style = colNum >= 10 ? numStyle : dataStyle;
          cell.font = { bold: true, size: 11 };
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFE066' } };
        }
      });
    }

    if (rows.length === 0) {
      ws.addRow(['Нема податоци за избраниот период']);
    }

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="ZitoLuks_${date_from}_${date_to}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (e) { console.error(e); res.status(500).send(e.message); }
});


// ── RETURN BY CLIENT REPORT ──────────────────────────────
router.get('/return-by-client', async (req, res) => {
  try {
    const t = today();
    const f = {
      date_from: req.query.date_from || t,
      date_to: req.query.date_to || t,
      market_id: req.query.market_id || '',
      article_code: req.query.article_code || '',
      company_id: req.query.company_id || ''
    };
    let sql = `
      SELECT m.name market_name, m.client_code, a.code art_code, a.name art_name,
             SUM(di.delivered_qty) tot_del,
             SUM(di.returned_qty)  tot_ret,
             SUM(di.delivered_qty - di.returned_qty) net_qty
      FROM delivery_items di
      JOIN deliveries d ON d.id = di.delivery_id
      JOIN markets m    ON m.id = d.market_id
      JOIN articles a   ON a.id = di.article_id
      WHERE d.date>=? AND d.date<=? AND m.is_large=0`;
    const params = [f.date_from, f.date_to];
    const markets = await db.allAsync('SELECT id, name, company_id FROM markets WHERE active=1 AND is_large=0 ORDER BY name');
    const companies = await db.allAsync('SELECT id, name FROM companies WHERE active=1 ORDER BY name');
    const articles = await db.allAsync('SELECT id,code,name FROM articles WHERE active=1 AND is_market_article=0 ORDER BY sort_order');
    if (f.company_id) { sql += ' AND m.company_id=?'; params.push(f.company_id); }
    if (f.market_id) { sql += ' AND d.market_id=?'; params.push(f.market_id); }
    if (f.article_code) { sql += ' AND a.code=?'; params.push(f.article_code); }
    sql += ' GROUP BY m.id, a.id HAVING tot_ret > 0 ORDER BY m.name, a.sort_order';
    const rows = await db.allAsync(sql, params);
    res.render('admin/return-by-client', { rows, markets, companies, articles, filters: f });
  } catch (e) { res.status(500).send(e.message); }
});

router.get('/return-by-group', async (req, res) => {
  try {
    const t = today();
    const f = { date_from: req.query.date_from || t, date_to: req.query.date_to || t };

    const result = [];
    for (const [key, g] of Object.entries(BREAD_GROUPS)) {
      const placeholders = g.codes.map(() => '?').join(',');
      const rows = await db.allAsync(`
        SELECT a.code art_code, a.name art_name,
               SUM(di.delivered_qty) tot_del,
               SUM(di.returned_qty)  tot_ret,
               SUM(di.delivered_qty - di.returned_qty) net_qty
        FROM delivery_items di
        JOIN deliveries d ON d.id = di.delivery_id
        JOIN articles a   ON a.id = di.article_id
        JOIN markets m    ON m.id = d.market_id
        WHERE d.date>=? AND d.date<=? AND m.is_large=0
          AND a.code IN (${placeholders})
        GROUP BY a.id
        ORDER BY a.sort_order`, [f.date_from, f.date_to, ...g.codes]);
      result.push({ ...g, key, rows });
    }
    res.render('admin/return-by-group', { result, filters: f });
  } catch (e) { res.status(500).send(e.message); }
});

// ── BREAD CATEGORY SALES REPORTS ─────────────────────────
router.get('/bread-report/:group', async (req, res) => {
  try {
    const group = BREAD_GROUPS[req.params.group];
    if (!group) return res.status(404).send('Непозната група');
    const t = today();
    const f = {
      date_from: req.query.date_from || t,
      date_to: req.query.date_to || t,
      market_id: req.query.market_id || ''
    };
    const markets = await db.allAsync('SELECT id,name FROM markets WHERE active=1 AND is_large=0 ORDER BY name');
    const placeholders = group.codes.map(() => '?').join(',');
    let sql = `
      SELECT m.name market_name, a.code art_code, a.name art_name,
             SUM(di.delivered_qty) tot_del,
             SUM(di.returned_qty)  tot_ret,
             SUM(di.delivered_qty - di.returned_qty) net_qty,
             a.price,
             SUM(di.delivered_qty - di.returned_qty) * a.price net_amount
      FROM delivery_items di
      JOIN deliveries d ON d.id = di.delivery_id
      JOIN markets m    ON m.id = d.market_id
      JOIN articles a   ON a.id = di.article_id
      WHERE d.date>=? AND d.date<=? AND m.is_large=0
        AND a.code IN (${placeholders})`;
    const params = [f.date_from, f.date_to, ...group.codes];
    if (f.market_id) { sql += ' AND d.market_id=?'; params.push(f.market_id); }
    sql += ' GROUP BY m.id, a.id HAVING net_qty > 0 ORDER BY m.name, a.sort_order';
    const rows = await db.allAsync(sql, params);
    res.render('admin/bread-report', { rows, markets, filters: f, group, groupKey: req.params.group });
  } catch (e) { res.status(500).send(e.message); }
});

// ── API: MARKETS ──────────────────────────────────────────

router.post('/api/markets', async (req, res) => {
  try {
    const { name, address, city, contact_name, contact_phone, client_code, object_code, company_id, is_large, portal_column_id } = req.body;
    if (!name) return res.json({ success: false, error: 'Назив е задолжителен' });
    const r = await db.runAsync('INSERT INTO markets (name,address,city,contact_name,contact_phone,client_code,object_code,company_id,is_large,portal_column_id) VALUES (?,?,?,?,?,?,?,?,?,?)', [name, address || null, city || null, contact_name || null, contact_phone || null, client_code || null, object_code || null, company_id || null, is_large ? 1 : 0, portal_column_id || null]);
    res.json({ success: true, id: r.lastID });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

router.put('/api/markets/:id', async (req, res) => {
  try {
    const { name, address, city, contact_name, contact_phone, client_code, object_code, company_id, is_large, portal_column_id } = req.body;
    await db.runAsync('UPDATE markets SET name=?,address=?,city=?,contact_name=?,contact_phone=?,client_code=?,object_code=?,company_id=?,is_large=?,portal_column_id=? WHERE id=?', [name, address || null, city || null, contact_name || null, contact_phone || null, client_code || null, object_code || null, company_id || null, is_large ? 1 : 0, portal_column_id || null, req.params.id]);
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// ── API: MARKET ARTICLES (for large markets) ───────────────

router.get('/api/markets/:id/articles', async (req, res) => {
  try {
    const rows = await db.allAsync('SELECT article_id FROM market_articles WHERE market_id=?', [req.params.id]);
    res.json(rows);
  } catch (e) { res.json({ error: e.message }); }
});

router.post('/api/markets/:id/articles', async (req, res) => {
  try {
    const { article_ids } = req.body; // array of ints
    // Replace all assignments for this market
    await db.runAsync('DELETE FROM market_articles WHERE market_id=?', [req.params.id]);
    for (const aid of (article_ids || [])) {
      await db.runAsync('INSERT OR IGNORE INTO market_articles (market_id, article_id) VALUES (?,?)', [req.params.id, aid]);
    }
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
    const { code, name, price, unit, external_code, is_market_article } = req.body;
    if (!name) return res.json({ success: false, error: 'Назив е задолжителен' });
    const mx = await db.getAsync('SELECT MAX(sort_order) mo FROM articles WHERE active=1');
    const r = await db.runAsync('INSERT INTO articles (code,name,price,unit,sort_order,external_code,is_market_article) VALUES (?,?,?,?,?,?,?)', [code || '', name, parseFloat(price) || 0, unit || 'kom', (mx.mo || 0) + 1, external_code || null, is_market_article ? 1 : 0]);
    res.json({ success: true, id: r.lastID });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

router.put('/api/articles/:id', async (req, res) => {
  try {
    const { code, name, price, unit, external_code, is_market_article } = req.body;
    await db.runAsync('UPDATE articles SET code=?,name=?,price=?,unit=?,external_code=?,is_market_article=? WHERE id=?', [code || '', name, parseFloat(price) || 0, unit || 'kom', external_code || null, is_market_article ? 1 : 0, req.params.id]);
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
    const { name, username, password, phone, portal_username, portal_password, portal_column_id } = req.body;
    if (!name || !username || !password) return res.json({ success: false, error: 'Сите полиња се задолжителни' });
    const hash = bcrypt.hashSync(password, 10);
    const r = await db.runAsync("INSERT INTO users (name,username,password,role,phone,portal_username,portal_password,portal_column_id) VALUES (?,?,?,'driver',?,?,?,?)", [name, username, hash, phone || null, portal_username || null, portal_password || null, portal_column_id || null]);
    res.json({ success: true, id: r.lastID });
  } catch (e) {
    res.json({ success: false, error: e.message.includes('UNIQUE') ? 'Корисничкото ime веќе постои' : e.message });
  }
});

router.put('/api/drivers/:id', async (req, res) => {
  try {
    const { name, username, password, phone, active, portal_username, portal_password, portal_column_id } = req.body;
    if (password) {
      const hash = bcrypt.hashSync(password, 10);
      await db.runAsync("UPDATE users SET name=?,username=?,password=?,phone=?,active=?,portal_username=?,portal_password=?,portal_column_id=? WHERE id=? AND role='driver'", [name, username, hash, phone || null, active ? 1 : 0, portal_username || null, portal_password || null, portal_column_id || null, req.params.id]);
    } else {
      await db.runAsync("UPDATE users SET name=?,username=?,phone=?,active=?,portal_username=?,portal_password=?,portal_column_id=? WHERE id=? AND role='driver'", [name, username, phone || null, active ? 1 : 0, portal_username || null, portal_password || null, portal_column_id || null, req.params.id]);
    }
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

router.post('/api/drivers/:id/test-matrix', async (req, res) => {
  try {
    const driver = await db.getAsync("SELECT * FROM users WHERE id=? AND role='driver'", [req.params.id]);
    if (!driver) return res.json({ success: false, error: 'Возачот не е пронајден' });
    if (!driver.portal_username || !driver.portal_password || !driver.portal_column_id) {
      return res.json({ success: false, error: 'Возачот нема подесено параметри за Matrix порталот' });
    }
    const { submitOrdersForDriver } = require('../services/orderSubmitter');
    submitOrdersForDriver(driver).catch(e => console.error('Manual matrix test failed:', e));
    res.json({ success: true, message: 'Процесот за испраќање е стартуван во позадина. Проверете ги логовите во терминалот.' });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
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

// ── API: COMPANIES ───────────────────────────────────────

router.get('/api/companies', async (req, res) => {
  try {
    const rows = await db.allAsync('SELECT id,name FROM companies WHERE active=1 ORDER BY name');
    res.json(rows);
  } catch (e) { res.json({ error: e.message }); }
});

router.post('/api/companies', async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.json({ success: false, error: 'Назив е задолжителен' });
    const r = await db.runAsync('INSERT INTO companies (name) VALUES (?)', [name]);
    res.json({ success: true, id: r.lastID });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

router.put('/api/companies/:id', async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.json({ success: false, error: 'Назив е задолжителен' });
    await db.runAsync('UPDATE companies SET name=? WHERE id=?', [name, req.params.id]);
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// ── API: HOLIDAYS ─────────────────────────────────────────

router.get('/api/holidays', async (req, res) => {
  try {
    const rows = await db.allAsync('SELECT date FROM holidays ORDER BY date DESC');
    res.json(rows);
  } catch (e) { res.json({ error: e.message }); }
});

router.post('/api/holidays', async (req, res) => {
  try {
    const { date } = req.body;
    if (!date) return res.json({ success: false, error: 'Датумот е задолжителен' });
    await db.runAsync('INSERT OR IGNORE INTO holidays (date) VALUES (?)', [date]);
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

router.delete('/api/holidays/:date', async (req, res) => {
  try {
    await db.runAsync('DELETE FROM holidays WHERE date=?', [req.params.date]);
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

router.delete('/api/companies/:id', async (req, res) => {
  try {
    await db.runAsync('UPDATE companies SET active=0 WHERE id=?', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// ── PAGE: COMPANIES ───────────────────────────────────────

router.get('/companies', async (req, res) => {
  try {
    const companies = await db.allAsync(`
      SELECT c.id, c.name,
             COUNT(m.id) market_count
      FROM companies c
      LEFT JOIN markets m ON m.company_id=c.id AND m.active=1
      WHERE c.active=1
      GROUP BY c.id ORDER BY c.name`);
    res.render('admin/companies', { companies });
  } catch (e) { res.status(500).send(e.message); }
});

module.exports = router;
