// Event cost, shared by the server (validation, change notices) and the browser (form, labels).
// Stored as cost_amount (a number; 0 = free) and cost_currency (an ISO 4217 code like "USD").

const MAX_COST = 1_000_000;
export const DEFAULT_CURRENCY = 'USD';

// Every currency this JavaScript engine knows, e.g. ["AED", "AFN", …].
export const CURRENCIES = Intl.supportedValuesOf('currency');

// Decimal places the currency uses (USD 2, JPY 0, BHD 3).
const currencyDigits = (currency) =>
  new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits;

// Form values → { amount, currency }, or { error }. Blank amount = free. Rounds to the currency's decimals.
export function parseCost(amount, currency) {
  const code = String(currency ?? '').trim().toUpperCase() || DEFAULT_CURRENCY;
  if (!CURRENCIES.includes(code)) return { error: `Unknown currency "${code}"` };
  const s = String(amount ?? '').trim();
  const n = s === '' ? 0 : Number(s);
  if (!Number.isFinite(n) || n < 0 || n > MAX_COST) return { error: `Cost must be a number from 0 (free) to ${MAX_COST.toLocaleString('en')}` };
  const k = 10 ** currencyDigits(code);
  return { amount: Math.round(n * k) / k, currency: code };
}

// "Free", "$12.50", "€10.00", "¥1,500", "CA$20.00" (format follows the viewer's locale).
export const costLabel = (amount, currency, locale) =>
  !amount ? 'Free' : new Intl.NumberFormat(locale, { style: 'currency', currency: currency || DEFAULT_CURRENCY }).format(amount);
