export function addDealerCodeToDataset(merged, dealerCode) {
  const value = String(dealerCode || 'active').trim().toUpperCase();
  const header = 'dealer_code';
  const headers = merged.headers.includes(header)
    ? merged.headers
    : [header, ...merged.headers];
  const rows = merged.rows.map(row => ({
    ...row,
    [header]: value
  }));

  return { headers, rows };
}

export function addSourceDealerCodeToDataset(merged, dealerCode) {
  const value = String(dealerCode || 'active').trim().toUpperCase();
  const header = 'source_dealer_code';
  const headers = merged.headers.includes(header)
    ? merged.headers
    : [header, ...merged.headers];
  const rows = merged.rows.map(row => ({
    ...row,
    [header]: value
  }));

  return { headers, rows };
}

export function addMetadataToDataset(merged, metadata = {}, context = {}) {
  const resolved = Object.fromEntries(
    Object.entries(metadata).map(([key, value]) => [
      String(key).trim(),
      typeof value === 'function' ? value(context) : value
    ])
  );
  const entries = Object.entries(resolved)
    .filter(([key]) => key);

  if (!entries.length) return merged;

  const metadataHeaders = entries
    .map(([key]) => key)
    .filter(header => !merged.headers.includes(header));
  const rows = merged.rows.map(row => ({
    ...row,
    ...Object.fromEntries(entries)
  }));

  return {
    headers: [...metadataHeaders, ...merged.headers],
    rows
  };
}
