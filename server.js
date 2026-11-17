const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// الاتصال بقاعدة البيانات SQLite باستخدام better-sqlite3 (سريع و بدون مشاكل على Render)
const db = new Database(path.join(__dirname, 'database.sqlite'));
console.log("🟢 Connecté à la قاعدة البيانات SQLite");

// إنشاء الجداول تلقائياً (Products, Purchases, Expenses)
db.exec(`
  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    client TEXT,
    category TEXT,
    prix_achat REAL DEFAULT 0,
    prix_vente REAL DEFAULT 0,
    date_saisie TEXT,
    statut_livraison TEXT DEFAULT 'Livré',
    stock INTEGER DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS purchases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category TEXT,
    title TEXT,
    amount REAL DEFAULT 0,
    date_saisie TEXT,
    status TEXT DEFAULT 'Payé'
  );

  CREATE TABLE IF NOT EXISTS expenses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category TEXT,
    title TEXT,
    amount REAL DEFAULT 0,
    date_saisie TEXT
  );
`);

// --- API PRODUCTS ---
app.get('/api/products', (req, res) => {
  try {
    const { category } = req.query;
    let stmt, rows;
    if (category) {
      stmt = db.prepare("SELECT * FROM products WHERE category = ? ORDER BY id DESC");
      rows = stmt.all(category);
    } else {
      stmt = db.prepare("SELECT * FROM products ORDER BY id DESC");
      rows = stmt.all();
    }
    res.json(rows || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/products', (req, res) => {
  try {
    const { name, client, category, prix_achat, prix_vente, date_saisie, statut_livraison, stock } = req.body;
    const stmt = db.prepare(`INSERT INTO products (name, client, category, prix_achat, prix_vente, date_saisie, statut_livraison, stock) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    const info = stmt.run(name, client, category, prix_achat || 0, prix_vente || 0, date_saisie, statut_livraison || 'Livré', stock || 1);
    res.json({ id: info.lastInsertRowid, ...req.body });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/products/:id', (req, res) => {
  try {
    const { id } = req.params;
    const { name, client, category, prix_achat, prix_vente, date_saisie, statut_livraison, stock } = req.body;
    const stmt = db.prepare(`UPDATE products SET name=?, client=?, category=?, prix_achat=?, prix_vente=?, date_saisie=?, statut_livraison=?, stock=? WHERE id=?`);
    stmt.run(name, client, category, prix_achat, prix_vente, date_saisie, statut_livraison, stock, id);
    res.json({ message: "Mis à jour" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/products/:id', (req, res) => {
  try {
    const stmt = db.prepare("DELETE FROM products WHERE id = ?");
    stmt.run(req.params.id);
    res.json({ message: "Supprimé" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- API PURCHASES (المشتريات) ---
app.get('/api/purchases', (req, res) => {
  try {
    const { category } = req.query;
    let stmt, rows;
    if (category) {
      stmt = db.prepare("SELECT * FROM purchases WHERE category = ? ORDER BY id DESC");
      rows = stmt.all(category);
    } else {
      stmt = db.prepare("SELECT * FROM purchases ORDER BY id DESC");
      rows = stmt.all();
    }
    res.json(rows || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/purchases', (req, res) => {
  try {
    const { category, title, amount, date_saisie, status } = req.body;
    const stmt = db.prepare(`INSERT INTO purchases (category, title, amount, date_saisie, status) VALUES (?, ?, ?, ?, ?)`);
    const info = stmt.run(category, title, amount || 0, date_saisie, status || 'Payé');
    res.json({ id: info.lastInsertRowid, category, title, amount, date_saisie, status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/purchases/:id', (req, res) => {
  try {
    const stmt = db.prepare("DELETE FROM purchases WHERE id = ?");
    stmt.run(req.params.id);
    res.json({ message: "Supprimé" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- API EXPENSES (المصاريف) ---
app.get('/api/expenses', (req, res) => {
  try {
    const { category } = req.query;
    let stmt, rows;
    if (category) {
      stmt = db.prepare("SELECT * FROM expenses WHERE category = ? ORDER BY id DESC");
      rows = stmt.all(category);
    } else {
      stmt = db.prepare("SELECT * FROM expenses ORDER BY id DESC");
      rows = stmt.all();
    }
    res.json(rows || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/expenses', (req, res) => {
  try {
    const { category, title, amount, date_saisie } = req.body;
    const stmt = db.prepare(`INSERT INTO expenses (category, title, amount, date_saisie) VALUES (?, ?, ?, ?)`);
    const info = stmt.run(category, title, amount || 0, date_saisie);
    res.json({ id: info.lastInsertRowid, category, title, amount, date_saisie });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/expenses/:id', (req, res) => {
  try {
    const stmt = db.prepare("DELETE FROM expenses WHERE id = ?");
    stmt.run(req.params.id);
    res.json({ message: "Supprimé" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Serveur démarré sur http://localhost:${PORT}`));