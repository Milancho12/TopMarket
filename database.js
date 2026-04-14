const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'zitoLuks.db');
const db = new sqlite3.Database(DB_PATH);

// Enable WAL mode and foreign keys
db.serialize(() => {
  db.run('PRAGMA journal_mode = WAL');
  db.run('PRAGMA foreign_keys = ON');
});

// Promisify helpers
db.runAsync = (sql, params=[]) => new Promise((resolve,reject) => db.run(sql, params, function(err){ if(err) reject(err); else resolve(this); }));
db.getAsync = (sql, params=[]) => new Promise((resolve,reject) => db.get(sql, params, (err,row) => err?reject(err):resolve(row)));
db.allAsync = (sql, params=[]) => new Promise((resolve,reject) => db.all(sql, params, (err,rows) => err?reject(err):resolve(rows)));

// Sync-like wrappers — used in routes via the initialized db
db.prepare = undefined; // remove better-sqlite3 API hint

// Initialize schema and seed
async function init() {
  await db.runAsync(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
    username TEXT NOT NULL UNIQUE, password TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'driver', phone TEXT, active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')))`);

  await db.runAsync(`CREATE TABLE IF NOT EXISTS markets (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
    address TEXT, contact_name TEXT, contact_phone TEXT, active INTEGER NOT NULL DEFAULT 1)`);

  await db.runAsync(`CREATE TABLE IF NOT EXISTS articles (
    id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL,
    name TEXT NOT NULL, unit TEXT NOT NULL DEFAULT 'kom',
    price REAL NOT NULL DEFAULT 0, sort_order INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1)`);

  await db.runAsync(`CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT, driver_id INTEGER NOT NULL,
    market_id INTEGER NOT NULL, date TEXT NOT NULL,
    FOREIGN KEY (driver_id) REFERENCES users(id),
    FOREIGN KEY (market_id) REFERENCES markets(id),
    UNIQUE(driver_id, market_id, date))`);

  await db.runAsync(`CREATE TABLE IF NOT EXISTS deliveries (
    id INTEGER PRIMARY KEY AUTOINCREMENT, driver_id INTEGER NOT NULL,
    market_id INTEGER NOT NULL, date TEXT NOT NULL,
    submitted_at TEXT, edited_at TEXT, notes TEXT, locked INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (driver_id) REFERENCES users(id),
    FOREIGN KEY (market_id) REFERENCES markets(id),
    UNIQUE(driver_id, market_id, date))`);

  await db.runAsync(`CREATE TABLE IF NOT EXISTS delivery_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT, delivery_id INTEGER NOT NULL,
    article_id INTEGER NOT NULL, delivered_qty INTEGER NOT NULL DEFAULT 0,
    returned_qty INTEGER NOT NULL DEFAULT 0, next_day_qty INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (delivery_id) REFERENCES deliveries(id) ON DELETE CASCADE,
    UNIQUE(delivery_id, article_id))`);

  // Migration: add next_day_qty if it doesn't exist
  try { await db.runAsync('ALTER TABLE delivery_items ADD COLUMN next_day_qty INTEGER NOT NULL DEFAULT 0'); } catch(e) {}

  await db.runAsync(`CREATE TABLE IF NOT EXISTS driver_markets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    driver_id INTEGER NOT NULL,
    market_id INTEGER NOT NULL,
    FOREIGN KEY (driver_id) REFERENCES users(id),
    FOREIGN KEY (market_id) REFERENCES markets(id),
    UNIQUE(driver_id, market_id))`);

  // Seed admin
  const admin = await db.getAsync("SELECT id FROM users WHERE role='admin'");
  if (!admin) {
    const hash = bcrypt.hashSync('admin123', 10);
    await db.runAsync("INSERT INTO users (name,username,password,role) VALUES (?,?,?,'admin')", ['Администратор','admin',hash]);
    console.log('✅ Admin: admin / admin123');
  }

  // Seed articles
  const cnt = (await db.getAsync('SELECT COUNT(*) c FROM articles')).c;
  if (cnt === 0) {
    const arts = [
      ['814','Bel Rolovan leb',30,0], ['94','Bel leb na parcinja',33,1],
      ['737','100% Integ Rzano brasno.',64,2], ['738','100% Integ miks seminja',64,3],
      ['770','100% Celo zrno CIA i KINOA',73,4], ['868','7 Dnevna svezina',37,5],
      ['417','XL Rzan tost 500gr.',83,6], ['418','XL Bel Tost 500pr.',80,7],
      ['644','Bavarski leb',49,8], ['643','Graham Leb',49,9],
      ['870','Nordik',49,10], ['806','Nutri 6 Seminja',59,11],
      ['89','Bel Tost',58,12], ['90','Rzan Tost',60,13],
      ['641','Integraln tost',60,14], ['642','Miks od Zrna',62,15],
      ['669','Puter Brios',66,16], ['723','DIJA tost leb',60,17],
      ['778','Proteinski tost leb',75,18], ['948','Dvojno Pak. Bel Tost',93,19],
      ['949','Dvojno Pak. Rzan Tost',94,20], ['725','Vodenicar 400gr.',25,21],
      ['430','Bel leb na parc.400gr.',27,22]
    ];
    for (const a of arts) {
      await db.runAsync('INSERT INTO articles (code,name,price,sort_order) VALUES (?,?,?,?)', [a[0],a[1],a[2],a[3]]);
    }
    console.log(`✅ ${arts.length} артикли додадени`);
  }
  console.log('✅ База на податоци подготвена');
}

module.exports = { db, init };
