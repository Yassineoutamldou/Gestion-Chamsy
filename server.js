const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// الاتصال بقاعدة البيانات SQLite
const db = new sqlite3.Database(path.join(__dirname, 'database.sqlite'), (err) => {
  if (err) console.error("Erreur Connexion DB:", err.message);
  else console.log("✅ Connecté à la قاعدة البيانات SQLite");
});

// إنشاء الجداول تلقائياً (Products, Purchases, Expenses)
db.serialize(() => {
  db.run(`
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
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS purchases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT,
      title TEXT,
      amount REAL DEFAULT 0,
      date_saisie TEXT,
      status TEXT DEFAULT 'Payé'
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS expenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT,
      title TEXT,
      amount REAL DEFAULT 0,
      date_saisie TEXT
    )
  `);
});

// --- API PRODUCTS ---
app.get('/api/products', (req, res) => {
  const { category } = req.query;
  const sql = category ? "SELECT * FROM products WHERE category = ? ORDER BY id DESC" : "SELECT * FROM products ORDER BY id DESC";
  const params = category ? [category] : [];
  db.all(sql, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows || []);
  });
});

app.post('/api/products', (req, res) => {
  const { name, client, category, prix_achat, prix_vente, date_saisie, statut_livraison, stock } = req.body;
  const sql = `INSERT INTO products (name, client, category, prix_achat, prix_vente, date_saisie, statut_livraison, stock) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
  db.run(sql, [name, client, category, prix_achat || 0, prix_vente || 0, date_saisie, statut_livraison || 'Livré', stock || 1], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ id: this.lastID, ...req.body });
  });
});

app.put('/api/products/:id', (req, res) => {
  const { id } = req.params;
  const { name, client, category, prix_achat, prix_vente, date_saisie, statut_livraison, stock } = req.body;
  const sql = `UPDATE products SET name=?, client=?, category=?, prix_achat=?, prix_vente=?, date_saisie=?, statut_livraison=?, stock=? WHERE id=?`;
  db.run(sql, [name, client, category, prix_achat, prix_vente, date_saisie, statut_livraison, stock, id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ message: "Mis à jour" });
  });
});

app.delete('/api/products/:id', (req, res) => {
  db.run("DELETE FROM products WHERE id = ?", [req.params.id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ message: "Supprimé" });
  });
});

// --- API PURCHASES (المشتريات) ---
app.get('/api/purchases', (req, res) => {
  const { category } = req.query;
  const sql = category ? "SELECT * FROM purchases WHERE category = ? ORDER BY id DESC" : "SELECT * FROM purchases ORDER BY id DESC";
  const params = category ? [category] : [];
  db.all(sql, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows || []);
  });
});

app.post('/api/purchases', (req, res) => {
  const { category, title, amount, date_saisie, status } = req.body;
  const sql = `INSERT INTO purchases (category, title, amount, date_saisie, status) VALUES (?, ?, ?, ?, ?)`;
  db.run(sql, [category, title, amount || 0, date_saisie, status || 'Payé'], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ id: this.lastID, category, title, amount, date_saisie, status });
  });
});

app.delete('/api/purchases/:id', (req, res) => {
  db.run("DELETE FROM purchases WHERE id = ?", [req.params.id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ message: "Supprimé" });
  });
});

// --- API EXPENSES (المصاريف) ---
app.get('/api/expenses', (req, res) => {
  const { category } = req.query;
  const sql = category ? "SELECT * FROM expenses WHERE category = ? ORDER BY id DESC" : "SELECT * FROM expenses ORDER BY id DESC";
  const params = category ? [category] : [];
  db.all(sql, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows || []);
  });
});

app.post('/api/expenses', (req, res) => {
  const { category, title, amount, date_saisie } = req.body;
  const sql = `INSERT INTO expenses (category, title, amount, date_saisie) VALUES (?, ?, ?, ?)`;
  db.run(sql, [category, title, amount || 0, date_saisie], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ id: this.lastID, category, title, amount, date_saisie });
  });
});

app.delete('/api/expenses/:id', (req, res) => {
  db.run("DELETE FROM expenses WHERE id = ?", [req.params.id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ message: "Supprimé" });
  });
});

const PORT = 5000;
app.listen(PORT, () => console.log(`🚀 Serveur démarré sur http://localhost:${PORT}`));