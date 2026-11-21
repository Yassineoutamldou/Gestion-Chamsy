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

const mapSenditStatus = (parcelOrRaw = '') => {
  const rawStatus =
    typeof parcelOrRaw === 'object' && parcelOrRaw !== null
      ? extractRawSenditStatus(parcelOrRaw)
      : String(parcelOrRaw || '');

  const trimmed = String(rawStatus || '').trim();
  if (!trimmed) return 'En attente';

  const key = norm(trimmed);

  // Ila kant b-s-a-7 livraison f triq (machi livre)
  if (
    key.includes('en cours de livraison') ||
    key.includes('out for delivery') ||
    key.includes('cours de livraison')
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
