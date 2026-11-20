const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 5000;
const SENDIT_API_BASE = process.env.SENDIT_API_URL || 'https://app.sendit.ma/api/v1';
const START_DATE_NOV_2026 = new Date('2026-11-01T00:00:00.000Z');

const CASA_ENVIRONS = [
  'bouskoura',
  'nouaceur',
  'dar bouazza',
  'tit mellil',
  'mohammedia',
  'berrechid',
  'mediouna',
  'sidi rahal',
  'ain harrouda',
  'lahraouiyine',
  'salmia',
  'lissasfa',
  'had soualem',
  'deroua'
];

const db = new Database(path.join(__dirname, 'database.sqlite'));
console.log('🟢 Connecté à la base de données SQLite');

const initDB = () => {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS products (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        client TEXT DEFAULT '',
        city TEXT DEFAULT '',
        tracking_code TEXT DEFAULT '',
        category TEXT NOT NULL,
        stock INTEGER DEFAULT 1,
        sold_count INTEGER DEFAULT 0,
        prix_achat REAL DEFAULT 0,
        prix_vente REAL DEFAULT 0,
        frais_livraison_unit REAL DEFAULT 35,
        statut TEXT DEFAULT 'En attente',
        statut_livraison TEXT DEFAULT 'En attente',
        statut_facturation TEXT DEFAULT 'En attente',
        source_sendit INTEGER DEFAULT 0,
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
      "ALTER TABLE products ADD COLUMN city TEXT DEFAULT ''",
      "ALTER TABLE products ADD COLUMN tracking_code TEXT DEFAULT ''",
      "ALTER TABLE products ADD COLUMN sold_count INTEGER DEFAULT 0",
      "ALTER TABLE products ADD COLUMN frais_livraison_unit REAL DEFAULT 35",
      "ALTER TABLE products ADD COLUMN statut TEXT DEFAULT 'En attente'",
      "ALTER TABLE products ADD COLUMN statut_livraison TEXT DEFAULT 'En attente'",
      "ALTER TABLE products ADD COLUMN statut_facturation TEXT DEFAULT 'En attente'",
      "ALTER TABLE products ADD COLUMN source_sendit INTEGER DEFAULT 0",
      "ALTER TABLE products ADD COLUMN date_saisie TEXT",
      "ALTER TABLE purchases ADD COLUMN status TEXT DEFAULT 'Payé'"
    ];

    for (const q of alterQueries) {
      try {
        db.exec(q);
      } catch (e) {}
    }

    console.log('Database SQLite ready!');
  } catch (err) {
    console.error('Erreur DB SQLite:', err.message);
  }
};

initDB();

const getFoulardCredentials = () => ({
  publicKey: process.env.SENDIT_FOULARD_PUBLIC_KEY || process.env.SENDIT_PUBLIC_KEY || '',
  secretKey: process.env.SENDIT_FOULARD_SECRET_KEY || process.env.SENDIT_SECRET_KEY || ''
});

let cachedToken = null;
let tokenExpiresAt = 0;

const getSenditToken = async (forceRefresh = false) => {
  const { publicKey, secretKey } = getFoulardCredentials();
  if (!publicKey || !secretKey) {
    throw new Error('Clés Sendit Foulard manquantes dans les variables d’environnement');
  }

  const now = Date.now();
  if (!forceRefresh && cachedToken && now < tokenExpiresAt) {
    return cachedToken;
  }

  const res = await fetch(`${SENDIT_API_BASE}/login`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      public_key: publicKey,
      secret_key: secretKey
    })
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Erreur login Sendit (${res.status}): ${errText}`);
  }

  const json = await res.json();
  const token =
    json?.token ||
    json?.access_token ||
    json?.data?.token ||
    json?.data?.access_token ||
    '';

  if (!token) {
    throw new Error('Token introuvable dans la réponse POST /login Sendit');
  }

  cachedToken = token;
  tokenExpiresAt = now + 50 * 60 * 1000;
  return cachedToken;
};

const computeDeliveryFee = (city = '', districtName = '', senditFee = null) => {
  const text = `${city} ${districtName}`.toLowerCase().trim();
  if (text) {
    for (const env of CASA_ENVIRONS) {
      if (text.includes(env)) return 29;
    }
    if (text.includes('casablanca') || text.includes('casa')) {
      return 19;
    }
    return 35;
  }
  if (senditFee !== null && senditFee !== undefined && !Number.isNaN(Number(senditFee))) {
    return Number(senditFee);
  }
  return 35;
};

const normalizeText = (val = '') =>
  String(val)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[_-]+/g, ' ')
    .trim();

const mapSenditStatus = (rawStatus = '') => {
  const s = normalizeText(rawStatus);
  if (!s) return 'En attente';

  if (s === 'dd' || s === 'delivered' || s === 'livre' || s.includes('deliv') || s.includes('livre')) {
    return 'Livré';
  }
  if (s.includes('rembours') || s.includes('refund') || s.includes('paid')) {
    return 'Remboursé';
  }
  if (s === 'rt' || s === 'refused' || s === 'refuse' || s.includes('refus') || s.includes('retour') || s.includes('return')) {
    return 'Refusé';
  }
  if (s === 'canceled' || s === 'cancelled' || s === 'annule' || s.includes('cancel') || s.includes('annul')) {
    return 'Annulé';
  }
  if (s.includes('en cours de livraison') || s.includes('delivering') || s.includes('out for delivery')) {
    return 'En cours de livraison';
  }
  if (s.includes('programm') || s === 'prog') {
    return 'Programmé';
  }
  if (s.includes('report') || s.includes('postpon')) {
    return 'Reporté';
  }
  if (s.includes('injoignable') || s.includes('unreachable') || s.includes('no answer')) {
    return 'Injoignable';
  }
  if (s.includes('distribu')) {
    return 'Distribué';
  }
  if (s.includes('transit')) {
    return 'En transit';
  }
  if (s.includes('entrepot') || s.includes('warehouse') || s.includes('hub')) {
    return 'Entrepôt';
  }
  if (s.includes('ramassage a verifier') || s.includes('verify')) {
    return 'Ramassage à vérifier';
  }
  if (s.includes('ramassage en cours') || s.includes('pickup in progress')) {
    return 'Ramassage en cours';
  }
  if (s.includes('ramasse') || s.includes('picked')) {
    return 'Ramassé';
  }
  if (s.includes('a changer') || s.includes('change')) {
    return 'À changer';
  }
  if (s.includes('a preparer') || s.includes('prepar')) {
    return 'À préparer';
  }
  if (s.includes('attente') || s === 'pending' || s === 'new' || s === 'created') {
    return 'En attente';
  }

  return String(rawStatus).trim();
};

const mapFacturationStatus = (parcel = {}) => {
  const raw =
    parcel.facturation_status ||
    parcel.billing_status ||
    parcel.invoice_status ||
    parcel.payment_status ||
    parcel.facturation ||
    parcel.facture ||
    parcel.paid ||
    '';

  if (raw === true || raw === 1) return 'Facturé';
  const s = normalizeText(raw);
  if (!s || raw === false || raw === 0) return 'En attente';

  if (s.includes('facture') || s.includes('invoiced') || s.includes('billed') || s.includes('paid') || s.includes('paye')) {
    return 'Facturé';
  }
  if (s.includes('cours') || s.includes('progress') || s.includes('processing')) {
    return 'En cours';
  }
  return 'En attente';
};

const extractParcelDate = (parcel) => {
  const raw =
    parcel.created_at ||
    parcel.date_creation ||
    parcel.createdAt ||
    parcel.date ||
    parcel.updated_at ||
    '';
  if (!raw) return null;
  const dt = new Date(raw);
  return Number.isNaN(dt.getTime()) ? null : dt;
};

const isSinceNov1_2026 = (parcel) => {
  const dt = extractParcelDate(parcel);
  if (!dt) return true;
  return dt >= START_DATE_NOV_2026;
};

const extractListFromResponse = (json) => {
  if (Array.isArray(json)) return json;
  if (Array.isArray(json?.data)) return json.data;
  if (Array.isArray(json?.data?.data)) return json.data.data;
  if (Array.isArray(json?.deliveries)) return json.deliveries;
  if (Array.isArray(json?.parcels)) return json.parcels;
  return [];
};

const fetchSenditPage = async (url, token) => {
  return fetch(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    }
  });
};

const fetchSenditDeliveriesAllPages = async () => {
  let token = await getSenditToken(false);
  const allItems = [];
  const seenCodes = new Set();

  for (let page = 1; page <= 15; page += 1) {
    const url =
      page === 1 ? `${SENDIT_API_BASE}/deliveries` : `${SENDIT_API_BASE}/deliveries?page=${page}`;
    let res = await fetchSenditPage(url, token);

    if (res.status === 401 || res.status === 403) {
      token = await getSenditToken(true);
      res = await fetchSenditPage(url, token);
    }

    if (!res.ok) {
      if (page === 1) {
        const errText = await res.text();
        throw new Error(`Erreur GET /deliveries Sendit (${res.status}): ${errText}`);
      }
      break;
    }

    const json = await res.json();
    const list = extractListFromResponse(json);
    if (!list.length) break;

    let addedInPage = 0;
    for (const item of list) {
      const code = String(item.code || item.tracking_code || item.reference || '').trim();
      const uniqueKey = code || JSON.stringify(item);
      if (!seenCodes.has(uniqueKey)) {
        seenCodes.add(uniqueKey);
        allItems.push(item);
        addedInPage += 1;
      }
    }

    if (addedInPage === 0) break;
  }

  return allItems;
};

const syncFoulardFromSendit = async () => {
  const allParcels = await fetchSenditDeliveriesAllPages();
  const novParcels = allParcels.filter(isSinceNov1_2026);

  let insertedCount = 0;
  let updatedCount = 0;

  const findRow = db.prepare(
    'SELECT id, client, city, prix_vente, frais_livraison_unit, statut_livraison, statut_facturation, date_saisie FROM products WHERE tracking_code = ? AND category = ?'
  );

  const insertRow = db.prepare(`
    INSERT INTO products
    (name, client, city, tracking_code, category, stock, sold_count, prix_achat, prix_vente, frais_livraison_unit, statut, statut_livraison, statut_facturation, source_sendit, date_saisie)
    VALUES (?, ?, ?, ?, 'Foulard', 1, 0, 0, ?, ?, ?, ?, ?, 1, ?)
  `);

  const updateRow = db.prepare(`
    UPDATE products
    SET client = ?, city = ?, prix_vente = ?, frais_livraison_unit = ?, statut_livraison = ?, statut_facturation = ?, source_sendit = 1, date_saisie = ?
    WHERE id = ?
  `);

  for (const p of novParcels) {
    const code = String(p.code || p.tracking_code || p.reference || '').trim();
    if (!code) continue;

    const district = p.district && typeof p.district === 'object' ? p.district : {};
    const cityStr = String(district.ville || p.city || p.ville || '').trim();
    const districtStr = String(district.name || p.district || '').trim();
    const displayCity = cityStr || districtStr || '—';
    const clientStr = String(p.name || p.client || p.phone || code).trim();
    const salePrice = Number(p.amount ?? p.price ?? 0) || 0;
    const fee = computeDeliveryFee(cityStr, districtStr, p.fee);
    const statusLabel = mapSenditStatus(p.status || p.etat || '');
    const facturationLabel = mapFacturationStatus(p);

    const dt = extractParcelDate(p);
    const dateStr = dt
      ? dt.toISOString().slice(0, 10)
      : new Date().toISOString().slice(0, 10);

    const existing = findRow.get(code, 'Foulard');
    if (!existing) {
      insertRow.run(
        `Colis ${code}`,
        clientStr,
        displayCity,
        code,
        salePrice,
        fee,
        statusLabel,
        statusLabel,
        facturationLabel,
        dateStr
      );
      insertedCount += 1;
    } else {
      const hasChanged =
        existing.client !== clientStr ||
        existing.city !== displayCity ||
        Number(existing.prix_vente) !== salePrice ||
        Number(existing.frais_livraison_unit) !== fee ||
        existing.statut_livraison !== statusLabel ||
        (existing.statut_facturation || 'En attente') !== facturationLabel ||
        (existing.date_saisie || '') !== dateStr;

      if (hasChanged) {
        updateRow.run(
          clientStr,
          displayCity,
          salePrice,
          fee,
          statusLabel,
          facturationLabel,
          dateStr,
          existing.id
        );
        updatedCount += 1;
      }
    }
  }

  return {
    category: 'Foulard',
    since: '2026-11-01',
    syncedAt: new Date().toISOString(),
    totalParcels: novParcels.length,
    insertedCount,
    updatedCount
  };
};

// --- ROUTES SYNC SENDIT (Foulard uniquement) ---
const handleSyncFoulard = async (req, res) => {
  try {
    const result = await syncFoulardFromSendit();
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

app.post('/api/sync-sendit', handleSyncFoulard);
app.get('/api/sync-sendit', handleSyncFoulard);

// --- WEBHOOK SENDIT (Foulard) ---
app.post('/api/webhook/sendit', (req, res) => {
  try {
    const payload = req.body || {};
    const p = payload.data || payload.parcel || payload.delivery || payload;
    const code = String(p.code || p.tracking_code || p.reference || '').trim();
    const statusLabel = mapSenditStatus(p.status || p.etat || '');
    const facturationLabel = mapFacturationStatus(p);

    if (code && statusLabel) {
      db.prepare(`
        UPDATE products
        SET statut_livraison = ?, statut_facturation = ?
        WHERE tracking_code = ? AND category = 'Foulard'
      `).run(statusLabel, facturationLabel, code);
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- API PRODUCTS (La date jdida l-foq, w 01/11/2026 l-t-ḥ-t) ---
app.get('/api/products', (req, res) => {
  const { category } = req.query;
  try {
    const rows = category
      ? db
          .prepare('SELECT * FROM products WHERE category = ? ORDER BY date_saisie DESC, id DESC')
          .all(category)
      : db.prepare('SELECT * FROM products ORDER BY date_saisie DESC, id DESC').all();
    res.json(Array.isArray(rows) ? rows : []);
  } catch (err) {
    console.error('Erreur GET /api/products:', err.message);
    res.status(200).json([]);
  }
});

app.post('/api/products', (req, res) => {
  const {
    name,
    client,
    city,
    tracking_code,
    category,
    stock,
    prix_achat,
    prix_vente,
    frais_livraison_unit,
    statut,
    statut_livraison,
    statut_facturation,
    date_saisie
  } = req.body;

  try {
    const isMagasin = category === 'Magasin';
    const info = db.prepare(`
      INSERT INTO products
      (name, client, city, tracking_code, category, stock, sold_count, prix_achat, prix_vente, frais_livraison_unit, statut, statut_livraison, statut_facturation, date_saisie)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      name,
      client || '',
      city || '',
      tracking_code || '',
      category || 'Foulard',
      Number(stock) || 1,
      Number(prix_achat) || 0,
      Number(prix_vente) || 0,
      isMagasin ? 0 : (Number(frais_livraison_unit) ?? 35),
      statut || 'En attente',
      statut_livraison || (isMagasin ? 'Livré' : 'En attente'),
      statut_facturation || (isMagasin ? 'Facturé' : 'En attente'),
      date_saisie || new Date().toISOString().slice(0, 10)
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
    city,
    tracking_code,
    category,
    stock,
    prix_achat,
    prix_vente,
    frais_livraison_unit,
    statut,
    statut_livraison,
    statut_facturation,
    date_saisie
  } = req.body;

  try {
    const isMagasin = category === 'Magasin';
    db.prepare(`
      UPDATE products
      SET name = ?, client = ?, city = ?, tracking_code = ?, category = ?, stock = ?, prix_achat = ?, prix_vente = ?, frais_livraison_unit = ?, statut = ?, statut_livraison = ?, statut_facturation = ?, date_saisie = ?
      WHERE id = ?
    `).run(
      name,
      client || '',
      city || '',
      tracking_code || '',
      category,
      Number(stock) || 1,
      Number(prix_achat) || 0,
      Number(prix_vente) || 0,
      isMagasin ? 0 : (Number(frais_livraison_unit) ?? 35),
      statut || 'En attente',
      statut_livraison || (isMagasin ? 'Livré' : 'En attente'),
      statut_facturation || (isMagasin ? 'Facturé' : 'En attente'),
      date_saisie || new Date().toISOString().slice(0, 10),
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

// --- EXPENSES (Décharges : Ads, Fournisseurs, Logement...) ---
app.get('/api/expenses', (req, res) => {
  const { category } = req.query;
  try {
    const rows = category
      ? db.prepare('SELECT * FROM expenses WHERE category = ? ORDER BY id DESC').all(category)
      : db.prepare('SELECT * FROM expenses ORDER BY id DESC').all();
    res.json(Array.isArray(rows) ? rows : []);
  } catch (err) {
    res.status(200).json([]);
  }
});

app.post('/api/expenses', (req, res) => {
  const { category, title, amount, date_saisie } = req.body;
  try {
    const info = db.prepare(
      'INSERT INTO expenses (category, title, amount, date_saisie) VALUES (?, ?, ?, ?)'
    ).run(category || 'Foulard', title, Number(amount) || 0, date_saisie || new Date().toISOString().slice(0, 10));
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
    ).run(category || 'Foulard', title, Number(amount) || 0, date_saisie || new Date().toISOString().slice(0, 10), req.params.id);
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

// --- PURCHASES & INVENTORIES ---
app.get('/api/purchases', (req, res) => {
  const { category } = req.query;
  try {
    const rows = category
      ? db.prepare('SELECT * FROM purchases WHERE category = ? ORDER BY id DESC').all(category)
      : db.prepare('SELECT * FROM purchases ORDER BY id DESC').all();
    res.json(Array.isArray(rows) ? rows : []);
  } catch (err) {
    res.status(200).json([]);
  }
});

app.post('/api/purchases', (req, res) => {
  const { category, title, amount, status, date_saisie } = req.body;
  try {
    const info = db.prepare(
      'INSERT INTO purchases (category, title, amount, status, date_saisie) VALUES (?, ?, ?, ?, ?)'
    ).run(category || 'Magasin', title, Number(amount) || 0, status || 'Payé', date_saisie || new Date().toISOString().slice(0, 10));
    res.json({ success: true, id: info.lastInsertRowid });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/inventories', (req, res) => {
  const { category } = req.query;
  try {
    const rows = category
      ? db.prepare('SELECT * FROM inventories WHERE category = ? ORDER BY id DESC').all(category)
      : db.prepare('SELECT * FROM inventories ORDER BY id DESC').all();
    res.json(Array.isArray(rows) ? rows : []);
  } catch (err) {
    res.status(200).json([]);
  }
});

app.post('/api/inventories', (req, res) => {
  const { category, title, stock_value, date_saisie } = req.body;
  try {
    const info = db.prepare(
      'INSERT INTO inventories (category, title, stock_value, date_saisie) VALUES (?, ?, ?, ?)'
    ).run(category || 'Magasin', title, Number(stock_value) || 0, date_saisie || new Date().toISOString().slice(0, 10));
    res.json({ success: true, id: info.lastInsertRowid });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- AUTO SYNC EVERY 20 MINUTES ---
const TWENTY_MINUTES_MS = 20 * 60 * 1000;
setInterval(() => {
  const { publicKey, secretKey } = getFoulardCredentials();
  if (!publicKey || !secretKey) return;
  syncFoulardFromSendit()
    .then((res) => console.log('Sendit Foulard auto-sync (20min):', res))
    .catch((err) => console.log('Sendit Foulard auto-sync error:', err.message));
}, TWENTY_MINUTES_MS);

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
