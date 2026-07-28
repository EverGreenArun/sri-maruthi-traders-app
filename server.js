require('dotenv').config();
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const path = require('path');
const { db, initDb } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-this-in-production';
const COOKIE_NAME = 'smt_admin_token';

app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
// AUTH HELPERS
// ============================================================
function requireAdmin(req, res, next) {
  const token = req.cookies[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: 'Not logged in' });
  try {
    req.admin = jwt.verify(token, JWT_SECRET);
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Session expired, please log in again' });
  }
}

// Wrap async route handlers so thrown errors/rejections reach Express instead of hanging
function ah(fn) {
  return (req, res) => fn(req, res).catch(err => {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  });
}

// ============================================================
// PUBLIC API (no login needed) — what the customer-facing page uses
// ============================================================
app.get('/api/catalog', ah(async (req, res) => {
  const categories = (await db.execute('SELECT * FROM categories ORDER BY sort_order')).rows;
  const items = (await db.execute('SELECT * FROM items ORDER BY sort_order')).rows;
  const shopInfo = (await db.execute('SELECT * FROM shop_info WHERE id = 1')).rows[0];

  const itemsFor = (catId) => items
    .filter(i => i.category_id === catId)
    .map(i => ({ id: i.id, name: i.name, unit: i.unit, price: i.price }));

  const topCategories = categories.filter(c => !c.parent_id);

  const catalog = topCategories.map(cat => ({
    id: cat.id,
    name: cat.name,
    items: itemsFor(cat.id),
    subcategories: categories
      .filter(sub => sub.parent_id === cat.id)
      .map(sub => ({ id: sub.id, name: sub.name, items: itemsFor(sub.id) }))
  }));

  res.json({ shopInfo, catalog });
}));

// ============================================================
// AUTH ROUTES
// ============================================================
app.post('/api/login', ah(async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

  const admin = (await db.execute('SELECT * FROM admin_user WHERE id = 1')).rows[0];
  if (!admin || admin.username !== username) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  const valid = bcrypt.compareSync(password, admin.password_hash);
  if (!valid) return res.status(401).json({ error: 'Invalid username or password' });

  const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: '12h' });
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 12 * 60 * 60 * 1000
  });
  res.json({ success: true });
}));

app.post('/api/logout', (req, res) => {
  res.clearCookie(COOKIE_NAME);
  res.json({ success: true });
});

app.get('/api/me', requireAdmin, (req, res) => {
  res.json({ username: req.admin.username });
});

app.post('/api/change-password', requireAdmin, ah(async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Current and new password required' });
  }
  if (newPassword.length < 6) {
    return res.status(400).json({ error: 'New password must be at least 6 characters' });
  }
  const admin = (await db.execute('SELECT * FROM admin_user WHERE id = 1')).rows[0];
  const valid = bcrypt.compareSync(currentPassword, admin.password_hash);
  if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });

  const newHash = bcrypt.hashSync(newPassword, 10);
  await db.execute({ sql: 'UPDATE admin_user SET password_hash = ? WHERE id = 1', args: [newHash] });
  res.json({ success: true });
}));

// ============================================================
// ADMIN API (login required) — manage categories, items, shop info
// ============================================================

// --- Shop info ---
app.put('/api/admin/shop-info', requireAdmin, ah(async (req, res) => {
  const { shop_name, tagline, phone, whatsapp, address } = req.body;
  await db.execute({
    sql: `UPDATE shop_info SET shop_name = ?, tagline = ?, phone = ?, whatsapp = ?, address = ?, last_updated = ?
          WHERE id = 1`,
    args: [shop_name, tagline, phone, whatsapp, address, new Date().toISOString().slice(0, 10)]
  });
  res.json({ success: true });
}));

// --- Categories ---
app.post('/api/admin/categories', requireAdmin, ah(async (req, res) => {
  const { name, parent_id } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Category name required' });

  let parentId = null;
  if (parent_id) {
    const parent = (await db.execute({ sql: 'SELECT * FROM categories WHERE id = ?', args: [parent_id] })).rows[0];
    if (!parent) return res.status(400).json({ error: 'Parent category not found' });
    if (parent.parent_id) return res.status(400).json({ error: 'Subcategories cannot be nested further' });
    parentId = parent.id;
  }

  const maxOrder = (await db.execute({
    sql: 'SELECT COALESCE(MAX(sort_order), -1) AS m FROM categories WHERE parent_id IS ?',
    args: [parentId]
  })).rows[0].m;

  const result = await db.execute({
    sql: 'INSERT INTO categories (name, sort_order, parent_id) VALUES (?, ?, ?)',
    args: [name.trim(), maxOrder + 1, parentId]
  });
  res.json({ id: Number(result.lastInsertRowid), name: name.trim(), parent_id: parentId });
}));

app.put('/api/admin/categories/:id', requireAdmin, ah(async (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Category name required' });
  await db.execute({ sql: 'UPDATE categories SET name = ? WHERE id = ?', args: [name.trim(), req.params.id] });
  res.json({ success: true });
}));

app.delete('/api/admin/categories/:id', requireAdmin, ah(async (req, res) => {
  const subIds = (await db.execute({
    sql: 'SELECT id FROM categories WHERE parent_id = ?',
    args: [req.params.id]
  })).rows.map(r => r.id);
  const allIds = [Number(req.params.id), ...subIds];
  const placeholders = allIds.map(() => '?').join(',');
  await db.execute({ sql: `DELETE FROM items WHERE category_id IN (${placeholders})`, args: allIds });
  await db.execute({ sql: `DELETE FROM categories WHERE id IN (${placeholders})`, args: allIds });
  res.json({ success: true });
}));

// --- Items ---
app.post('/api/admin/items', requireAdmin, ah(async (req, res) => {
  const { category_id, name, unit, price } = req.body;
  if (!category_id || !name || !name.trim() || price === undefined || price === null || isNaN(price)) {
    return res.status(400).json({ error: 'category_id, name and a valid price are required' });
  }
  const maxOrder = (await db.execute({
    sql: 'SELECT COALESCE(MAX(sort_order), -1) AS m FROM items WHERE category_id = ?',
    args: [category_id]
  })).rows[0].m;
  const result = await db.execute({
    sql: 'INSERT INTO items (category_id, name, unit, price, sort_order) VALUES (?, ?, ?, ?, ?)',
    args: [category_id, name.trim(), unit || null, Number(price), maxOrder + 1]
  });
  res.json({ id: Number(result.lastInsertRowid) });
}));

app.put('/api/admin/items/:id', requireAdmin, ah(async (req, res) => {
  const { name, unit, price } = req.body;
  if (!name || !name.trim() || price === undefined || price === null || isNaN(price)) {
    return res.status(400).json({ error: 'name and a valid price are required' });
  }
  await db.execute({
    sql: 'UPDATE items SET name = ?, unit = ?, price = ? WHERE id = ?',
    args: [name.trim(), unit || null, Number(price), req.params.id]
  });
  res.json({ success: true });
}));

app.delete('/api/admin/items/:id', requireAdmin, ah(async (req, res) => {
  await db.execute({ sql: 'DELETE FROM items WHERE id = ?', args: [req.params.id] });
  res.json({ success: true });
}));

// ============================================================
// Fallback: serve index.html for the root
// ============================================================
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============================================================
// Start server (after the database schema/seed is ready)
// ============================================================
initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Sri Maruthi Traders app running on http://localhost:${PORT}`);
    });
  })
  .catch(err => {
    console.error('Failed to start — could not set up the database:', err);
    process.exit(1);
  });
