require('dotenv').config();
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const path = require('path');
const db = require('./db');

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

// ============================================================
// PUBLIC API (no login needed) — what the customer-facing page uses
// ============================================================
app.get('/api/catalog', (req, res) => {
  const categories = db.prepare('SELECT * FROM categories ORDER BY sort_order').all();
  const items = db.prepare('SELECT * FROM items ORDER BY sort_order').all();
  const shopInfo = db.prepare('SELECT * FROM shop_info WHERE id = 1').get();

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
});

// ============================================================
// AUTH ROUTES
// ============================================================
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

  const admin = db.prepare('SELECT * FROM admin_user WHERE id = 1').get();
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
});

app.post('/api/logout', (req, res) => {
  res.clearCookie(COOKIE_NAME);
  res.json({ success: true });
});

app.get('/api/me', requireAdmin, (req, res) => {
  res.json({ username: req.admin.username });
});

app.post('/api/change-password', requireAdmin, (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Current and new password required' });
  }
  if (newPassword.length < 6) {
    return res.status(400).json({ error: 'New password must be at least 6 characters' });
  }
  const admin = db.prepare('SELECT * FROM admin_user WHERE id = 1').get();
  const valid = bcrypt.compareSync(currentPassword, admin.password_hash);
  if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });

  const newHash = bcrypt.hashSync(newPassword, 10);
  db.prepare('UPDATE admin_user SET password_hash = ? WHERE id = 1').run(newHash);
  res.json({ success: true });
});

// ============================================================
// ADMIN API (login required) — manage categories, items, shop info
// ============================================================

// --- Shop info ---
app.put('/api/admin/shop-info', requireAdmin, (req, res) => {
  const { shop_name, tagline, phone, whatsapp, address } = req.body;
  db.prepare(`
    UPDATE shop_info SET shop_name = ?, tagline = ?, phone = ?, whatsapp = ?, address = ?, last_updated = ?
    WHERE id = 1
  `).run(shop_name, tagline, phone, whatsapp, address, new Date().toISOString().slice(0, 10));
  res.json({ success: true });
});

// --- Categories ---
app.post('/api/admin/categories', requireAdmin, (req, res) => {
  const { name, parent_id } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Category name required' });

  let parentId = null;
  if (parent_id) {
    const parent = db.prepare('SELECT * FROM categories WHERE id = ?').get(parent_id);
    if (!parent) return res.status(400).json({ error: 'Parent category not found' });
    if (parent.parent_id) return res.status(400).json({ error: 'Subcategories cannot be nested further' });
    parentId = parent.id;
  }

  const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM categories WHERE parent_id IS ?').get(parentId).m;
  const result = db.prepare('INSERT INTO categories (name, sort_order, parent_id) VALUES (?, ?, ?)').run(name.trim(), maxOrder + 1, parentId);
  res.json({ id: result.lastInsertRowid, name: name.trim(), parent_id: parentId });
});

app.put('/api/admin/categories/:id', requireAdmin, (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Category name required' });
  db.prepare('UPDATE categories SET name = ? WHERE id = ?').run(name.trim(), req.params.id);
  res.json({ success: true });
});

app.delete('/api/admin/categories/:id', requireAdmin, (req, res) => {
  const subIds = db.prepare('SELECT id FROM categories WHERE parent_id = ?').all(req.params.id).map(r => r.id);
  const allIds = [Number(req.params.id), ...subIds];
  const placeholders = allIds.map(() => '?').join(',');
  db.prepare(`DELETE FROM items WHERE category_id IN (${placeholders})`).run(...allIds);
  db.prepare(`DELETE FROM categories WHERE id IN (${placeholders})`).run(...allIds);
  res.json({ success: true });
});

// --- Items ---
app.post('/api/admin/items', requireAdmin, (req, res) => {
  const { category_id, name, unit, price } = req.body;
  if (!category_id || !name || !name.trim() || price === undefined || price === null || isNaN(price)) {
    return res.status(400).json({ error: 'category_id, name and a valid price are required' });
  }
  const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM items WHERE category_id = ?').get(category_id).m;
  const result = db.prepare('INSERT INTO items (category_id, name, unit, price, sort_order) VALUES (?, ?, ?, ?, ?)')
    .run(category_id, name.trim(), unit || null, Number(price), maxOrder + 1);
  res.json({ id: result.lastInsertRowid });
});

app.put('/api/admin/items/:id', requireAdmin, (req, res) => {
  const { name, unit, price } = req.body;
  if (!name || !name.trim() || price === undefined || price === null || isNaN(price)) {
    return res.status(400).json({ error: 'name and a valid price are required' });
  }
  db.prepare('UPDATE items SET name = ?, unit = ?, price = ? WHERE id = ?')
    .run(name.trim(), unit || null, Number(price), req.params.id);
  res.json({ success: true });
});

app.delete('/api/admin/items/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM items WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ============================================================
// Fallback: serve index.html for the root
// ============================================================
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Sri Maruthi Traders app running on http://localhost:${PORT}`);
});
