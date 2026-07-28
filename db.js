const { createClient } = require('@libsql/client');
const bcrypt = require('bcryptjs');

if (!process.env.TURSO_DATABASE_URL || !process.env.TURSO_AUTH_TOKEN) {
  console.error('\n[SETUP] TURSO_DATABASE_URL and/or TURSO_AUTH_TOKEN are missing from your .env file.');
  console.error('[SETUP] Create a free database at https://turso.tech and paste its values into .env — see README.\n');
}

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

// ---------- Schema + seed data (runs once at startup) ----------
async function initDb() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      parent_id INTEGER REFERENCES categories(id) ON DELETE CASCADE
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      unit TEXT,
      price REAL NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS shop_info (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      shop_name TEXT,
      tagline TEXT,
      phone TEXT,
      whatsapp TEXT,
      address TEXT,
      last_updated TEXT
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS admin_user (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      username TEXT NOT NULL,
      password_hash TEXT NOT NULL
    )
  `);

  // Migration: add parent_id if this database was created before subcategories existed
  const cols = await db.execute('PRAGMA table_info(categories)');
  const hasParentId = cols.rows.some(r => r.name === 'parent_id');
  if (!hasParentId) {
    await db.execute('ALTER TABLE categories ADD COLUMN parent_id INTEGER REFERENCES categories(id) ON DELETE CASCADE');
  }

  // ---------- Seed (only if empty) ----------
  const categoryCount = (await db.execute('SELECT COUNT(*) AS c FROM categories')).rows[0].c;

  if (categoryCount === 0) {
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

    for (let catIdx = 0; catIdx < seedData.length; catIdx++) {
      const cat = seedData[catIdx];
      const result = await db.execute({
        sql: 'INSERT INTO categories (name, sort_order) VALUES (?, ?)',
        args: [cat.name, catIdx]
      });
      const categoryId = Number(result.lastInsertRowid);
      for (let itemIdx = 0; itemIdx < cat.items.length; itemIdx++) {
        const item = cat.items[itemIdx];
        await db.execute({
          sql: 'INSERT INTO items (category_id, name, unit, price, sort_order) VALUES (?, ?, ?, ?, ?)',
          args: [categoryId, item[0], item[1], item[2], itemIdx]
        });
      }
    }

    await db.execute({
      sql: `INSERT INTO shop_info (id, shop_name, tagline, phone, whatsapp, address, last_updated)
            VALUES (1, ?, ?, ?, ?, ?, ?)`,
      args: [
        'Sri Maruthi Traders',
        'Madurai · Electrical & Hardware Supplies',
        '+91 00000 00000',
        '+91 00000 00000',
        'Your shop address, Madurai, Tamil Nadu',
        new Date().toISOString().slice(0, 10)
      ]
    });
  }

  // ---------- Default admin user (only if none exists) ----------
  const adminExists = (await db.execute('SELECT COUNT(*) AS c FROM admin_user')).rows[0].c;
  if (adminExists === 0) {
    const defaultUsername = process.env.ADMIN_USERNAME || 'admin';
    const defaultPassword = process.env.ADMIN_PASSWORD || 'changeme123';
    const hash = bcrypt.hashSync(defaultPassword, 10);
    await db.execute({
      sql: 'INSERT INTO admin_user (id, username, password_hash) VALUES (1, ?, ?)',
      args: [defaultUsername, hash]
    });
    console.log(`\n[SETUP] Default admin created — username: "${defaultUsername}", password: "${defaultPassword}"`);
    console.log('[SETUP] Please log in and change this immediately, or set ADMIN_USERNAME / ADMIN_PASSWORD env vars.\n');
  }
}

module.exports = { db, initDb };
