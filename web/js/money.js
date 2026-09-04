// All money in this app is integer minor units (cents) end to end, matching the DB schema
// -- these two functions are the ONLY place cents <-> display-decimal conversion happens.

const SYMBOLS = { USD: '$', ZWG: 'ZWG ', ZAR: 'R', EUR: '€', GBP: '£' };

export function formatCents(cents, currency = 'USD') {
  if (cents === null || cents === undefined) return '—';
  const amount = (Number(cents) / 100).toFixed(2);
  const prefix = SYMBOLS[currency] ?? `${currency} `;
  return `${prefix}${amount}`;
}

export function toCents(decimalAmount) {
  return Math.round(Number(decimalAmount) * 100);
}
