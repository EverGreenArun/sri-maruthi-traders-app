const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');

const db = new Database(path.join(__dirname, 'data.sqlite'));
db.pragma('journal_mode = WAL');

// ---------- Schema ----------
db.exec(`
CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  parent_id INTEGER REFERENCES categories(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  unit TEXT,
  price REAL NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS shop_info (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  shop_name TEXT,
  tagline TEXT,
  phone TEXT,
  whatsapp TEXT,
  address TEXT,
  last_updated TEXT
);

CREATE TABLE IF NOT EXISTS admin_user (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  username TEXT NOT NULL,
  password_hash TEXT NOT NULL
);
`);

// ---------- Migration: add parent_id to categories if upgrading an older database ----------
const categoryColumns = db.prepare("PRAGMA table_info(categories)").all();
if (!categoryColumns.some(col => col.name === 'parent_id')) {
  db.exec('ALTER TABLE categories ADD COLUMN parent_id INTEGER REFERENCES categories(id) ON DELETE CASCADE');
}

// ---------- Seed (only if empty) ----------
const categoryCount = db.prepare('SELECT COUNT(*) AS c FROM categories').get().c;

if (categoryCount === 0) {
  const insertCategory = db.prepare('INSERT INTO categories (name, sort_order) VALUES (?, ?)');
  const insertItem = db.prepare('INSERT INTO items (category_id, name, unit, price, sort_order) VALUES (?, ?, ?, ?, ?)');

  const seedData = [
    {
      name: 'Wires & Cables',
      items: [
        ['1.5 sq mm Copper Wire', 'per meter', 12],
        ['2.5 sq mm Copper Wire', 'per meter', 18],
        ['4 sq mm Copper Wire', 'per meter', 28],
        ['Flexible Wire (Multi-strand)', 'per meter', 15],
      ]
    },
    {
      name: 'Switches & Sockets',
      items: [
        ['Modular Switch — 6A', 'per piece', 45],
        ['Modular Switch — 16A', 'per piece', 65],
        ['5-Pin Socket', 'per piece', 55],
        ['Switch Plate (2 Module)', 'per piece', 30],
      ]
    },
    {
      name: 'MCBs & Distribution',
      items: [
        ['Single Pole MCB — 16A', 'per piece', 120],
        ['Double Pole MCB — 32A', 'per piece', 280],
        ['Distribution Board — 8 Way', 'per piece', 650],
      ]
    },
    {
      name: 'Lighting',
      items: [
        ['LED Bulb — 9W', 'per piece', 85],
        ['LED Tube Light — 20W', 'per piece', 220],
        ['Ceiling Rose', 'per piece', 25],
      ]
    },
  ];

  seedData.forEach((cat, catIdx) => {
    const result = insertCategory.run(cat.name, catIdx);
    const categoryId = result.lastInsertRowid;
    cat.items.forEach((item, itemIdx) => {
      insertItem.run(categoryId, item[0], item[1], item[2], itemIdx);
    });
  });

  db.prepare(`
    INSERT INTO shop_info (id, shop_name, tagline, phone, whatsapp, address, last_updated)
    VALUES (1, ?, ?, ?, ?, ?, ?)
  `).run(
    'Sri Maruthi Traders',
    'Madurai · Electrical & Hardware Supplies',
    '+91 00000 00000',
    '+91 00000 00000',
    'Your shop address, Madurai, Tamil Nadu',
    new Date().toISOString().slice(0, 10)
  );
}

// ---------- Default admin user (only if none exists) ----------
const adminExists = db.prepare('SELECT COUNT(*) AS c FROM admin_user').get().c;
if (adminExists === 0) {
  const defaultUsername = process.env.ADMIN_USERNAME || 'admin';
  const defaultPassword = process.env.ADMIN_PASSWORD || 'changeme123';
  const hash = bcrypt.hashSync(defaultPassword, 10);
  db.prepare('INSERT INTO admin_user (id, username, password_hash) VALUES (1, ?, ?)').run(defaultUsername, hash);
  console.log(`\n[SETUP] Default admin created — username: "${defaultUsername}", password: "${defaultPassword}"`);
  console.log('[SETUP] Please log in and change this immediately, or set ADMIN_USERNAME / ADMIN_PASSWORD env vars.\n');
}

module.exports = db;
