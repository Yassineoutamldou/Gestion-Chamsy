const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 5000;

const SENDIT_PUBLIC_KEY = process.env.SENDIT_PUBLIC_KEY || '';
const SENDIT_SECRET_KEY = process.env.SENDIT_SECRET_KEY || '';
const SENDIT_API_BASE = process.env.SENDIT_API_URL || 'https://app.sendit.ma/api/v1';

const db = new Database(path.join(__dirname, 'database.sqlite'));
console.log("🟢 Connecté à la base de données SQLite");

const initDB = () => {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS products (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        client TEXT DEFAULT '',
        tracking_code TEXT DEFAULT '',
        category TEXT NOT NULL,
        stock INTEGER DEFAULT 1,
        sold_count INTEGER DEFAULT 0,
        prix_achat REAL DEFAULT 0,
        prix_vente REAL DEFAULT 0,
        frais_livraison_unit REAL DEFAULT 35,
        statut TEXT DEFAULT 'En attente',
        statut_livraison TEXT DEFAULT 'Livré',
        date_saisie TEXT
      );

      CREATE TABLE IF NOT EXISTS purchases (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category TEXT NOT NULL,
        title TEXT NOT NULL,
        amount REAL DEFAULT 0,
        status TEXT DEFAULT 'Payé',
        date_saisie TEXT
      );

      CREATE TABLE IF NOT EXISTS expenses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category TEXT NOT NULL,
        title TEXT NOT NULL,
        amount REAL DEFAULT 0,
        date_saisie TEXT
      );

      CREATE TABLE IF NOT EXISTS inventories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category TEXT NOT NULL,
        title TEXT NOT NULL,
        stock_value REAL DEFAULT 0,
        date_saisie TEXT
      );
    `);

    const alterQueries = [
      "ALTER TABLE products ADD COLUMN client TEXT DEFAULT ''",
      "ALTER TABLE products ADD COLUMN tracking_code TEXT DEFAULT ''",
      "ALTER TABLE products ADD COLUMN sold_count INTEGER DEFAULT 0",
      "ALTER TABLE products ADD COLUMN frais_livraison_unit REAL DEFAULT 35",
      "ALTER TABLE products ADD COLUMN statut TEXT DEFAULT 'En attente'",
      "ALTER TABLE products ADD COLUMN statut_livraison TEXT DEFAULT 'Livré'",
      "ALTER TABLE products ADD COLUMN date_saisie TEXT",
      "ALTER TABLE purchases ADD COLUMN status TEXT DEFAULT 'Payé'"
    ];

    for (const q of alterQueries) {
      try {
        db.exec(q);
      } catch (e) {}
    }

    console.log("Database SQLite ready!");
  } catch (err) {
    console.error("Erreur DB SQLite:", err.message);
  }
};

initDB();

// --- CACHE TOKEN SENDIT ---
let cachedSenditToken = null;
let tokenExpiresAt = 0;

const getSenditToken = async (forceRefresh = false) => {
  if (!SENDIT_PUBLIC_KEY || !SENDIT_SECRET_KEY) {
    throw new Error("Clés Sendit manquantes dans les variables d'environnement (SENDIT_PUBLIC_KEY / SENDIT_SECRET_KEY)");
  }

  const now = Date.now();
  if (!forceRefresh && cachedSenditToken && now < tokenExpiresAt) {
    return cachedSenditToken;
  }

  const response = await fetch(`${SENDIT_API_BASE}/login`, {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      public_key: SENDIT_PUBLIC_KEY,
      secret_key: SENDIT_SECRET_KEY
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Erreur authentification Sendit (${response.status}): ${errText}`);
  }

  const data = await response.json();
  const token =
    data?.token ||
    data?.access_token ||
    data?.data?.token ||
    data?.data?.access_token ||
    '';

  if (!token) {
    throw new Error("Jeton introuvable dans la réponse de POST /login Sendit");
  }

  cachedSenditToken = token;
  tokenExpiresAt = now + 50 * 60 * 1000; // renouvellement toutes les 50 minutes
  return cachedSenditToken;
};

const mapSenditStatus = (rawStatus = '') => {
  const s = String(rawStatus).toLowerCase().trim();
  if (s.includes('deliv') || s.includes('livré') || s.includes('livre') || s === 'dd') {
    return 'Livré';
  }
  if (s.includes('refus') || s.includes('return') || s.includes('retour') || s.includes('annul') || s === 'rt') {
    return 'Refusé';
  }
  return null;
};

const fetchSenditParcels = async () => {
  let token = await getSenditToken(false);

  let response = await fetch(`${SENDIT_API_BASE}/deliveries`, {
    method: 'GET',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    }
  });

  if (response.status === 401 || response.status === 403) {
    token = await getSenditToken(true);
    response = await fetch(`${SENDIT_API_BASE}/deliveries`, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      }
    });
  }

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Erreur API Sendit (${response.status}): ${errText}`);
  }

  const data = await response.json();
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.data)) return data.data;
  if (Array.isArray(data.deliveries)) return data.deliveries;
  if (Array.isArray(data.parcels)) return data.parcels;
  return [];
};

const syncSenditStatuses = async () => {
  const parcels = await fetchSenditParcels();
  let updatedCount = 0;

  const stmt = db.prepare(`
    UPDATE products
    SET statut_livraison = ?
    WHERE tracking_code = ? AND category = 'Foulard' AND statut_livraison != ?
  `);

  for (const parcel of parcels) {
    const code = String(
      parcel.code || parcel.tracking_code || parcel.reference || parcel.id || ''
    ).trim();
    const mappedStatus = mapSenditStatus(
      parcel.status || parcel.etat || parcel.state || parcel.delivery_status || ''
    );

    if (!code || !mappedStatus) continue;

    const info = stmt.run(mappedStatus, code, mappedStatus);
    if (info && info.changes > 0) {
      updatedCount += info.changes;
    }
  }

  return { targetCategory: 'Foulard', totalParcels: parcels.length, updatedCount };
};

// --- ROUTES SYNC SENDIT ---
app.post('/api/sync-sendit', async (req, res) => {
  try {
    const result = await syncSenditStatuses();
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/sync-sendit', async (req, res) => {
  try {
    const result = await syncSenditStatuses();
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- WEBHOOK SENDIT (catégorie Foulard) ---
app.post('/api/webhook/sendit', (req, res) => {
  try {
    const payload = req.body || {};
    const parcel = payload.data || payload.parcel || payload.delivery || payload;
    const code = String(
      parcel.code || parcel.tracking_code || parcel.reference || parcel.id || ''
    ).trim();
    const mappedStatus = mapSenditStatus(
      parcel.status || parcel.etat || parcel.state || parcel.delivery_status || ''
    );

    if (code && mappedStatus) {
      db.prepare(`
        UPDATE products
        SET statut_livraison = ?
        WHERE tracking_code = ? AND category = 'Foulard'
      `).run(mappedStatus, code);
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- API PRODUCTS ---
app.get('/api/products', (req, res) => {
  const { category } = req.query;
  try {
    const rows = category
      ? db.prepare('SELECT * FROM products WHERE category = ? ORDER BY id DESC').all(category)
      : db.prepare('SELECT * FROM products ORDER BY id DESC').all();
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/products', (req, res) => {
  const {
    name,
    client,
    tracking_code,
    category,
    stock,
    prix_achat,
    prix_vente,
    frais_livraison_unit,
    statut,
    statut_livraison,
    date_saisie
  } = req.body;

  try {
    const isMagasin = category === 'Magasin';
    const info = db.prepare(`
      INSERT INTO products
      (name, client, tracking_code, category, stock, sold_count, prix_achat, prix_vente, frais_livraison_unit, statut, statut_livraison, date_saisie)
      VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)
    `).run(
      name,
      client || '',
      tracking_code || '',
      category || 'General',
      Number(stock) || 1,
      Number(prix_achat) || 0,
      Number(prix_vente) || 0,
      isMagasin ? 0 : (Number(frais_livraison_unit) ?? 35),
      statut || 'En attente',
      statut_livraison || 'Livré',
      date_saisie || null
    );
    res.json({ success: true, id: info.lastInsertRowid });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/products/:id', (req, res) => {
  const { id } = req.params;
  const {
    name,
    client,
    tracking_code,
    category,
    stock,
    prix_achat,
    prix_vente,
    frais_livraison_unit,
    statut,
    statut_livraison,
    date_saisie
  } = req.body;

  try {
    const isMagasin = category === 'Magasin';
    db.prepare(`
      UPDATE products
      SET name = ?, client = ?, tracking_code = ?, category = ?, stock = ?, prix_achat = ?, prix_vente = ?, frais_livraison_unit = ?, statut = ?, statut_livraison = ?, date_saisie = ?
      WHERE id = ?
    `).run(
      name,
      client || '',
      tracking_code || '',
      category,
      Number(stock) || 1,
      Number(prix_achat) || 0,
      Number(prix_vente) || 0,
      isMagasin ? 0 : (Number(frais_livraison_unit) ?? 35),
      statut || 'En attente',
      statut_livraison || 'Livré',
      date_saisie || null,
      id
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/products/:id', (req, res) => {
  try {
    db.prepare('DELETE FROM products WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- PURCHASES ---
app.get('/api/purchases', (req, res) => {
  const { category } = req.query;
  try {
    const rows = category
      ? db.prepare('SELECT * FROM purchases WHERE category = ? ORDER BY id DESC').all(category)
      : db.prepare('SELECT * FROM purchases ORDER BY id DESC').all();
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/purchases', (req, res) => {
  const { category, title, amount, status, date_saisie } = req.body;
  try {
    const info = db.prepare(
      'INSERT INTO purchases (category, title, amount, status, date_saisie) VALUES (?, ?, ?, ?, ?)'
    ).run(category || 'General', title, Number(amount) || 0, status || 'Payé', date_saisie || null);
    res.json({ success: true, id: info.lastInsertRowid });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/purchases/:id', (req, res) => {
  const { category, title, amount, status, date_saisie } = req.body;
  try {
    db.prepare(
      'UPDATE purchases SET category = ?, title = ?, amount = ?, status = ?, date_saisie = ? WHERE id = ?'
    ).run(category || 'General', title, Number(amount) || 0, status || 'Payé', date_saisie || null, req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/purchases/:id', (req, res) => {
  try {
    db.prepare('DELETE FROM purchases WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- EXPENSES ---
app.get('/api/expenses', (req, res) => {
  const { category } = req.query;
  try {
    const rows = category
      ? db.prepare('SELECT * FROM expenses WHERE category = ? ORDER BY id DESC').all(category)
      : db.prepare('SELECT * FROM expenses ORDER BY id DESC').all();
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/expenses', (req, res) => {
  const { category, title, amount, date_saisie } = req.body;
  try {
    const info = db.prepare(
      'INSERT INTO expenses (category, title, amount, date_saisie) VALUES (?, ?, ?, ?)'
    ).run(category || 'General', title, Number(amount) || 0, date_saisie || null);
    res.json({ success: true, id: info.lastInsertRowid });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/expenses/:id', (req, res) => {
  const { category, title, amount, date_saisie } = req.body;
  try {
    db.prepare(
      'UPDATE expenses SET category = ?, title = ?, amount = ?, date_saisie = ? WHERE id = ?'
    ).run(category || 'General', title, Number(amount) || 0, date_saisie || null, req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/expenses/:id', (req, res) => {
  try {
    db.prepare('DELETE FROM expenses WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- INVENTORIES ---
app.get('/api/inventories', (req, res) => {
  const { category } = req.query;
  try {
    const rows = category
      ? db.prepare('SELECT * FROM inventories WHERE category = ? ORDER BY id DESC').all(category)
      : db.prepare('SELECT * FROM inventories ORDER BY id DESC').all();
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/inventories', (req, res) => {
  const { category, title, stock_value, date_saisie } = req.body;
  try {
    const info = db.prepare(
      'INSERT INTO inventories (category, title, stock_value, date_saisie) VALUES (?, ?, ?, ?)'
    ).run(category || 'General', title, Number(stock_value) || 0, date_saisie || null);
    res.json({ success: true, id: info.lastInsertRowid });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/inventories/:id', (req, res) => {
  try {
    db.prepare('DELETE FROM inventories WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- AUTO SYNC EVERY 2 HOURS ---
const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
setInterval(() => {
  if (!SENDIT_PUBLIC_KEY || !SENDIT_SECRET_KEY) return;
  syncSenditStatuses()
    .then((r) => console.log("Sendit auto-sync:", r))
    .catch((e) => console.log("Sendit auto-sync skipped/error:", e.message));
}, TWO_HOURS_MS);

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
