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
const META_GRAPH_VERSION = process.env.META_GRAPH_VERSION || 'v21.0';
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

const normalizeCategoryKey = (category = 'Foulard') => {
  const c = String(category)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
  if (c.includes('vetement')) return 'Vêtement';
  return 'Foulard';
};

const getSenditCredentialsForCategory = (category = 'Foulard') => {
  const canonical = normalizeCategoryKey(category);

  if (canonical === 'Vêtement') {
    return {
      canonicalCategory: 'Vêtement',
      publicKey:
        process.env.SENDIT_VETEMENT_PUBLIC_KEY || 'ed7f000d1640d7fc8865339f97fd19c5',
      secretKey:
        process.env.SENDIT_VETEMENT_SECRET_KEY || '3ENO9ezkizNtW5QpKInhLaO1x82RxSAd'
    };
  }

  return {
    canonicalCategory: 'Foulard',
    publicKey: process.env.SENDIT_FOULARD_PUBLIC_KEY || process.env.SENDIT_PUBLIC_KEY || '',
    secretKey: process.env.SENDIT_FOULARD_SECRET_KEY || process.env.SENDIT_SECRET_KEY || ''
  };
};

const tokenCache = {
  Foulard: { token: null, expiresAt: 0 },
  Vêtement: { token: null, expiresAt: 0 }
};

const getSenditToken = async (category = 'Foulard', forceRefresh = false) => {
  const { canonicalCategory, publicKey, secretKey } = getSenditCredentialsForCategory(category);
  if (!publicKey || !secretKey) {
    throw new Error(`Clés Sendit ${canonicalCategory} manquantes dans les variables d’environnement`);
  }

  const now = Date.now();
  const entry = tokenCache[canonicalCategory];
  if (!forceRefresh && entry?.token && now < entry.expiresAt) {
    return entry.token;
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
    throw new Error(`Erreur login Sendit (${canonicalCategory} - ${res.status}): ${errText}`);
  }

  const json = await res.json();
  const token =
    json?.token ||
    json?.access_token ||
    json?.data?.token ||
    json?.data?.access_token ||
    '';

  if (!token) {
    throw new Error(`Token introuvable dans la réponse POST /login Sendit (${canonicalCategory})`);
  }

  tokenCache[canonicalCategory] = {
    token,
    expiresAt: now + 50 * 60 * 1000
  };
  return token;
};

const extractSenditFee = (parcel = {}, city = '', districtName = '') => {
  const candidates = [
    parcel.fee,
    parcel.delivery_fee,
    parcel.frais_livraison,
    parcel.shipping_fee,
    parcel.tarif,
    parcel.district?.fee,
    parcel.district?.delivery_fee
  ];

  for (const val of candidates) {
    if (val !== null && val !== undefined && val !== '' && !Number.isNaN(Number(val))) {
      const num = Number(val);
      if (num > 0) return num;
    }
  }

  const text = `${city} ${districtName}`.toLowerCase().trim();
  if (text) {
    for (const env of CASA_ENVIRONS) {
      if (text.includes(env)) return 29;
    }
    if (text.includes('casablanca') || text.includes('casa')) {
      return 19;
    }
  }
  return 35;
};

const norm = (val = '') =>
  String(val)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const extractRawSenditStatus = (parcel = {}) => {
  const candidates = [
    parcel.status_label,
    parcel.status_name,
    parcel.status?.name,
    parcel.status?.label,
    parcel.status?.title,
    parcel.etat?.name,
    parcel.etat?.label,
    parcel.delivery_status,
    parcel.parcel_status,
    parcel.last_status,
    parcel.situation,
    parcel.status,
    parcel.etat,
    parcel.state
  ];

  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.trim();
    if (c && typeof c === 'object') {
      const nested = c.name || c.label || c.title || c.slug || c.code || '';
      if (String(nested).trim()) return String(nested).trim();
    }
  }
  return '';
};

const SENDIT_EXACT_MAP = {
  'en attente': 'En attente',
  'pending': 'En attente',
  'new': 'En attente',
  'created': 'En attente',
  'draft': 'En attente',
  'a preparer': 'À préparer',
  'à préparer': 'À préparer',
  'a changer': 'À changer',
  'à changer': 'À changer',
  'ramassage en cours': 'Ramassage en cours',
  'ramassage a verifier': 'Ramassage à vérifier',
  'ramassage à vérifier': 'Ramassage à vérifier',
  'ramasse': 'Ramassé',
  'ramassé': 'Ramassé',
  'picked up': 'Ramassé',
  'pickup': 'Ramassé',
  'entrepot': 'Entrepôt',
  'entrepôt': 'Entrepôt',
  'warehouse': 'Entrepôt',
  'en transit': 'En transit',
  'in transit': 'En transit',
  'distribue': 'Distribué',
  'distribué': 'Distribué',
  'injoignable': 'Injoignable',
  'unreachable': 'Injoignable',
  'reporte': 'Reporté',
  'reporté': 'Reporté',
  'postponed': 'Reporté',
  'programme': 'Programmé',
  'programmé': 'Programmé',
  'scheduled': 'Programmé',
  'en cours de livraison': 'En cours de livraison',
  'out for delivery': 'En cours de livraison',
  'delivering': 'En cours de livraison',
  'annule': 'Annulé',
  'annulé': 'Annulé',
  'canceled': 'Annulé',
  'cancelled': 'Annulé',
  'refuse': 'Refusé',
  'refusé': 'Refusé',
  'refused': 'Refusé',
  'rejected': 'Refusé',
  'retourne': 'Refusé',
  'retourné': 'Refusé',
  'returned': 'Refusé',
  'return': 'Refusé',
  'rt': 'Refusé',
  'livre': 'Livré',
  'livré': 'Livré',
  'delivered': 'Livré',
  'dd': 'Livré',
  'rembourse': 'Remboursé',
  'remboursé': 'Remboursé'
};

const mapSenditStatus = (parcelOrRaw = '') => {
  const rawStatus =
    typeof parcelOrRaw === 'object' && parcelOrRaw !== null
      ? extractRawSenditStatus(parcelOrRaw)
      : String(parcelOrRaw || '');

  const trimmed = String(rawStatus || '').trim();
  if (!trimmed) return 'En attente';

  const key = norm(trimmed);

  if (
    key.includes('en cours de livraison') ||
    key.includes('out for delivery') ||
    key.includes('cours de livraison') ||
    key.includes('delivering')
  ) {
    return 'En cours de livraison';
  }

  if (SENDIT_EXACT_MAP[key]) {
    return SENDIT_EXACT_MAP[key];
  }

  if (key.includes('ramass') && key.includes('cours')) return 'Ramassage en cours';
  if (key.includes('ramass') && key.includes('verif')) return 'Ramassage à vérifier';
  if (key.includes('ramass') || key.includes('pick')) return 'Ramassé';
  if (key.includes('entrepot') || key.includes('warehouse')) return 'Entrepôt';
  if (key.includes('transit')) return 'En transit';
  if (key.includes('distrib')) return 'Distribué';
  if (key.includes('injoign') || key.includes('unreach')) return 'Injoignable';
  if (key.includes('report')) return 'Reporté';
  if (key.includes('programm') || key.includes('schedul')) return 'Programmé';
  if (key.includes('livraison') || key.includes('delivery')) return 'En cours de livraison';
  if (key.includes('annul') || key.includes('cancel')) return 'Annulé';
  if (key.includes('refus') || key.includes('reject') || key.includes('retour') || key.includes('return')) {
    return 'Refusé';
  }
  if (key.includes('rembours')) return 'Remboursé';
  if (key === 'livre' || key === 'livree' || key === 'delivered' || key === 'dd') {
    return 'Livré';
  }
  if (key.includes('attent') || key.includes('pend')) return 'En attente';

  return trimmed;
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

const fetchSenditDeliveriesAllPages = async (category = 'Foulard') => {
  let token = await getSenditToken(category, true);
  const allItems = [];
  const seenCodes = new Set();

  for (let page = 1; page <= 15; page += 1) {
    const url =
      page === 1 ? `${SENDIT_API_BASE}/deliveries` : `${SENDIT_API_BASE}/deliveries?page=${page}`;
    let res = await fetchSenditPage(url, token);

    if (res.status === 401 || res.status === 403) {
      token = await getSenditToken(category, true);
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

const syncCategoryFromSendit = async (category = 'Foulard') => {
  const targetCategory = normalizeCategoryKey(category);
  const allParcels = await fetchSenditDeliveriesAllPages(targetCategory);
  const novParcels = allParcels.filter(isSinceNov1_2026);

  let insertedCount = 0;
  let updatedCount = 0;

  const findRow = db.prepare(
    'SELECT id, client, city, prix_achat, prix_vente, frais_livraison_unit, statut_livraison, date_saisie FROM products WHERE tracking_code = ? AND category = ?'
  );

  const insertRow = db.prepare(`
    INSERT INTO products
    (name, client, city, tracking_code, category, stock, sold_count, prix_achat, prix_vente, frais_livraison_unit, statut, statut_livraison, source_sendit, date_saisie)
    VALUES (?, ?, ?, ?, ?, 1, 0, ?, ?, ?, ?, ?, 1, ?)
  `);

  const updateRow = db.prepare(`
    UPDATE products
    SET client = ?, city = ?, prix_vente = ?, frais_livraison_unit = ?, statut_livraison = ?, source_sendit = 1, date_saisie = ?
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
    const fee = extractSenditFee(p, cityStr, districtStr);
    const statusLabel = mapSenditStatus(p);

    const dt = extractParcelDate(p);
    const dateStr = dt
      ? dt.toISOString().slice(0, 10)
      : new Date().toISOString().slice(0, 10);

    const existing = findRow.get(code, targetCategory);
    if (!existing) {
      insertRow.run(
        `Colis ${code}`,
        clientStr,
        displayCity,
        code,
        targetCategory,
        0,
        salePrice,
        fee,
        statusLabel,
        statusLabel,
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
        (existing.date_saisie || '') !== dateStr;

      if (hasChanged) {
        updateRow.run(
          clientStr,
          displayCity,
          salePrice,
          fee,
          statusLabel,
          dateStr,
          existing.id
        );
        updatedCount += 1;
      }
    }
  }

  return {
    category: targetCategory,
    since: '2026-11-01',
    syncedAt: new Date().toISOString(),
    totalParcels: novParcels.length,
    insertedCount,
    updatedCount
  };
};

// --- META ADS SYNC (Foulard uniquement — jamais Vêtement) ---
const syncFoulardMetaAds = async (monthParam = '') => {
  const accessToken = String(process.env.META_ACCESS_TOKEN || '').trim();
  const rawAccountId = String(process.env.META_AD_ACCOUNT_ID_FOULARD || '').trim();
  const usdToMad = Number(process.env.META_USD_TO_MAD) || 10;

  if (!accessToken) {
    throw new Error('META_ACCESS_TOKEN manquant dans Render');
  }
  if (!rawAccountId) {
    throw new Error('META_AD_ACCOUNT_ID_FOULARD manquant dans Render');
  }

  const adAccountId = rawAccountId.startsWith('act_') ? rawAccountId : `act_${rawAccountId}`;
  const targetMonth =
    /^\d{4}-\d{2}$/.test(monthParam) ? monthParam : new Date().toISOString().slice(0, 7);

  const [year, month] = targetMonth.split('-').map(Number);
  const firstDay = `${targetMonth}-01`;
  const lastDayDate = new Date(Date.UTC(year, month, 0));
  const todayStr = new Date().toISOString().slice(0, 10);
  const candidateLastDay = lastDayDate.toISOString().slice(0, 10);
  const untilDay = candidateLastDay > todayStr ? todayStr : candidateLastDay;

  const timeRange = encodeURIComponent(JSON.stringify({ since: firstDay, until: untilDay }));
  const url = `https://graph.facebook.com/${META_GRAPH_VERSION}/${adAccountId}/insights?fields=spend,impressions,clicks&time_range=${timeRange}&access_token=${encodeURIComponent(
    accessToken
  )}`;

  const res = await fetch(url);
  const json = await res.json();

  if (!res.ok || json?.error) {
    throw new Error(json?.error?.message || `Erreur Meta Graph API (${res.status})`);
  }

  const row = Array.isArray(json?.data) && json.data.length > 0 ? json.data[0] : {};
  const rawSpend = Number(row.spend) || 0;
  const spendMad = Number((rawSpend * usdToMad).toFixed(2));

  const title = `Meta Ads Foulard (${targetMonth})`;
  const entryDate = `${targetMonth}-01`;

  const existingExpense = db
    .prepare('SELECT id FROM expenses WHERE category = ? AND title = ?')
    .get('Foulard', title);

  if (existingExpense) {
    db.prepare('UPDATE expenses SET amount = ?, date_saisie = ? WHERE id = ?').run(
      spendMad,
      entryDate,
      existingExpense.id
    );
  } else {
    db.prepare(
      'INSERT INTO expenses (category, title, amount, date_saisie) VALUES (?, ?, ?, ?)'
    ).run('Foulard', title, spendMad, entryDate);
  }

  return {
    category: 'Foulard',
    adAccountId,
    month: targetMonth,
    rawSpend,
    usdToMad,
    spendMad
  };
};

app.post('/api/sync-meta', async (req, res) => {
  try {
    const rawCat = String(req.query?.category || req.body?.category || 'Foulard');
    if (normalizeCategoryKey(rawCat) !== 'Foulard') {
      return res.status(400).json({
        success: false,
        error: 'Meta Ads est configuré uniquement pour Foulard'
      });
    }
    const monthParam = String(req.query?.month || req.body?.month || '');
    const result = await syncFoulardMetaAds(monthParam);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- ROUTES SYNC SENDIT (Foulard & Vêtement séparément) ---
const handleSyncSendit = async (req, res) => {
  const rawCategory = req.query?.category || req.body?.category;
  try {
    if (rawCategory) {
      const result = await syncCategoryFromSendit(rawCategory);
      return res.json({ success: true, ...result });
    }

    const results = [];
    for (const cat of ['Foulard', 'Vêtement']) {
      try {
        const r = await syncCategoryFromSendit(cat);
        results.push(r);
      } catch (e) {
        results.push({ category: cat, error: e.message });
      }
    }
    const primary = results[0] || {};
    res.json({ success: true, ...primary, results });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

app.post('/api/sync-sendit', handleSyncSendit);
app.get('/api/sync-sendit', handleSyncSendit);

// --- WEBHOOK SENDIT ---
app.post('/api/webhook/sendit', (req, res) => {
  try {
    const payload = req.body || {};
    const p = payload.data || payload.parcel || payload.delivery || payload;
    const code = String(p.code || p.tracking_code || p.reference || '').trim();
    const statusLabel = mapSenditStatus(p);
    const targetCategory = req.query?.category
      ? normalizeCategoryKey(req.query.category)
      : null;

    if (code && statusLabel) {
      if (targetCategory) {
        db.prepare(`
          UPDATE products
          SET statut_livraison = ?
          WHERE tracking_code = ? AND category = ?
        `).run(statusLabel, code, targetCategory);
      } else {
        db.prepare(`
          UPDATE products
          SET statut_livraison = ?
          WHERE tracking_code = ?
        `).run(statusLabel, code);
      }
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
    date_saisie
  } = req.body;

  try {
    const isMagasin = category === 'Magasin';
    const info = db.prepare(`
      INSERT INTO products
      (name, client, city, tracking_code, category, stock, sold_count, prix_achat, prix_vente, frais_livraison_unit, statut, statut_livraison, date_saisie)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)
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
    date_saisie
  } = req.body;

  try {
    const isMagasin = category === 'Magasin';
    db.prepare(`
      UPDATE products
      SET name = ?, client = ?, city = ?, tracking_code = ?, category = ?, stock = ?, prix_achat = ?, prix_vente = ?, frais_livraison_unit = ?, statut = ?, statut_livraison = ?, date_saisie = ?
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

// --- AUTO SYNC EVERY 5 MINUTES (Foulard & Vêtement séparément) ---
const FIVE_MINUTES_MS = 5 * 60 * 1000;
setInterval(() => {
  for (const cat of ['Foulard', 'Vêtement']) {
    const creds = getSenditCredentialsForCategory(cat);
    if (!creds.publicKey || !creds.secretKey) continue;
    syncCategoryFromSendit(cat)
      .then((res) => console.log(`Sendit ${cat} auto-sync (5min):`, res))
      .catch((err) => console.log(`Sendit ${cat} auto-sync error:`, err.message));
  }
}, FIVE_MINUTES_MS);

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
