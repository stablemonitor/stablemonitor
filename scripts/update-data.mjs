import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(root, 'data/market-data.json');
const now = new Date();
const fetchedAt = now.toISOString();
function easternParts(date) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const values = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return { date: `${values.year}-${values.month}-${values.day}`, minutes: Number(values.hour) * 60 + Number(values.minute) };
}
const easternNow = easternParts(now);
const closedDate = date => date < easternNow.date || (date === easternNow.date && easternNow.minutes >= 16 * 60 + 15);
const sources = {
  CRCL: 'https://query2.finance.yahoo.com/v8/finance/chart/CRCL?range=2y&interval=1d',
  SPY: 'https://query2.finance.yahoo.com/v8/finance/chart/SPY?range=2y&interval=1d',
  usdc: 'https://stablecoins.llama.fi/stablecoincharts/all?stablecoin=2',
  totalStablecoins: 'https://stablecoins.llama.fi/stablecoincharts/all',
  rates: `https://markets.newyorkfed.org/api/rates/secured/sofr/search.json?startDate=2025-01-01&endDate=${easternNow.date}`
};
let previous = {};
try { previous = JSON.parse(await readFile(target, 'utf8')); } catch { /* First run has no cache. */ }
async function fetchJSON(url) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, { headers: { 'User-Agent': 'StableMonitor/1.0 public research dashboard', Accept: 'application/json' }, signal: AbortSignal.timeout(25000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (error) { lastError = error; }
  }
  throw lastError;
}
function pricesFrom(raw) {
  const result = raw.chart?.result?.[0];
  if (!result?.timestamp?.length) throw new Error('Empty Yahoo chart response');
  const quotes = result.indicators.quote[0], adj = result.indicators.adjclose?.[0]?.adjclose;
  return result.timestamp.map((timestamp, index) => ({
    date: easternParts(new Date(timestamp * 1000)).date,
    open: quotes.open[index], high: quotes.high[index], low: quotes.low[index], close: quotes.close[index],
    adjustedClose: adj?.[index] ?? null, volume: quotes.volume[index]
  })).filter(bar => closedDate(bar.date) && [bar.open, bar.high, bar.low, bar.close].every(n => Number.isFinite(n) && n > 0));
}
// The chart denominator is USD-pegged coins only, not EUR/other pegs converted to USD.
const circulating = row => Number.isFinite(row.totalCirculatingUSD?.peggedUSD) ? row.totalCirculatingUSD.peggedUSD : null;
const dateFromUnix = timestamp => new Date(Number(timestamp) * 1000).toISOString().slice(0, 10);
const result = await Promise.allSettled(Object.entries(sources).map(async ([key, url]) => ({ key, url, raw: await fetchJSON(url) })));
const loaded = {}, metadata = { generatedAt: fetchedAt, currentEasternDate: easternNow.date, currentEasternTimeMinutes: easternNow.minutes,
  closingPolicy: 'New York timezone; discard current-day bars before 16:15 ET. No intraday quotes. Undated chain data and SOFR lag by at least one calendar day in model.',
  pricesPolicy: 'CRCL and SPY raw daily OHLC; adjustedClose is retained for audit but scoring uses raw tradable prices. No dividend reinvestment.',
  stablecoinPolicy: 'USDC and totalStablecoins use totalCirculatingUSD.peggedUSD only; denominator excludes non-USD pegs. Historical supply may be revised by the source.',
  sources: {} };
let failures = 0;
for (let i = 0; i < result.length; i++) {
  const key = Object.keys(sources)[i], response = result[i];
  if (response.status === 'fulfilled') loaded[key] = response.value.raw;
  else { failures++; metadata.sources[key] = { status: 'failed', fetchedAt, asOf: previous.metadata?.sources?.[key]?.asOf ?? null, url: sources[key], error: String(response.reason?.message || response.reason) }; }
}
const data = { schemaVersion: 1, prices: { CRCL: [], SPY: [] }, usdc: [], rates: [], metadata };
function record(key, observations, authority, extra = {}) {
  metadata.sources[key] = { status: 'fresh', fetchedAt, asOf: observations.at(-1)?.date || null, url: sources[key], authority, ...extra };
}
for (const ticker of ['CRCL', 'SPY']) {
  try {
    if (!loaded[ticker]) throw new Error(metadata.sources[ticker].error);
    data.prices[ticker] = pricesFrom(loaded[ticker]);
    if (!data.prices[ticker].length) throw new Error('No closed daily bars');
    record(ticker, data.prices[ticker], 'third_party_market_data');
  } catch (error) {
    if (loaded[ticker]) failures++;
    data.prices[ticker] = (previous.prices?.[ticker] || []).filter(bar => closedDate(bar.date));
    metadata.sources[ticker] = { ...(metadata.sources[ticker] || {}), status: data.prices[ticker].length ? 'cached' : 'failed', fetchedAt, asOf: data.prices[ticker].at(-1)?.date || null, url: sources[ticker], error: String(error.message), cacheFetchedAt: previous.metadata?.sources?.[ticker]?.cacheFetchedAt || previous.metadata?.sources?.[ticker]?.fetchedAt || null };
  }
}
try {
  if (!Array.isArray(loaded.usdc) || !Array.isArray(loaded.totalStablecoins)) throw new Error(`Both USDC and USD-stablecoin histories are required: ${metadata.sources.usdc?.error || metadata.sources.totalStablecoins?.error || 'invalid response shape'}`);
  const totals = new Map(loaded.totalStablecoins.map(row => [dateFromUnix(row.date), circulating(row)]));
  data.usdc = loaded.usdc.map(row => { const date = dateFromUnix(row.date); return { date, usdc: circulating(row), totalStablecoins: totals.get(date) ?? null }; }).filter(row => row.date < easternNow.date && row.usdc > 0).sort((a, b) => a.date.localeCompare(b.date));
  if (!data.usdc.length) throw new Error('No lagged chain observations');
  record('usdc', data.usdc, 'third_party_onchain_aggregation');
  record('totalStablecoins', data.usdc.filter(row => row.totalStablecoins > 0), 'third_party_onchain_aggregation');
} catch (error) {
  if (loaded.usdc && loaded.totalStablecoins) failures++;
  data.usdc = (previous.usdc || []).filter(row => row.date < easternNow.date);
  for (const key of ['usdc', 'totalStablecoins']) metadata.sources[key] = { ...(metadata.sources[key] || {}), status: data.usdc.length ? 'cached' : 'failed', fetchedAt, asOf: data.usdc.at(-1)?.date || null, url: sources[key], error: String(error.message), cacheFetchedAt: previous.metadata?.sources?.[key]?.cacheFetchedAt || previous.metadata?.sources?.[key]?.fetchedAt || null };
}
try {
  const rawRates = loaded.rates?.refRates;
  if (!Array.isArray(rawRates)) throw new Error('No NY Fed refRates array');
  data.rates = rawRates.filter(row => row.type === 'SOFR' || !row.type).map(row => ({ date: row.effectiveDate, sofr: Number(row.percentRate) / 100, source: 'NYFed',
    // The rate refers to the previous business day and is published the next business morning.
    publicationPolicy: 'next_business_morning; model uses no rate dated current valuation day' })).filter(row => row.date < easternNow.date && Number.isFinite(row.sofr)).sort((a, b) => a.date.localeCompare(b.date));
  if (!data.rates.length) throw new Error('Empty official SOFR series');
  record('rates', data.rates, 'official_primary_NYFed');
} catch (error) {
  if (loaded.rates) failures++;
  data.rates = (previous.rates || []).filter(row => row.date < easternNow.date);
  metadata.sources.rates = { ...(metadata.sources.rates || {}), status: data.rates.length ? 'cached' : 'failed', fetchedAt, asOf: data.rates.at(-1)?.date || null, url: sources.rates, error: String(error.message), cacheFetchedAt: previous.metadata?.sources?.rates?.cacheFetchedAt || previous.metadata?.sources?.rates?.fetchedAt || null };
}
metadata.status = failures ? 'degraded' : 'fresh';
await writeFile(target, JSON.stringify(data, null, 2) + '\n');
console.log(JSON.stringify({ status: metadata.status, asOf: Object.fromEntries(Object.entries(metadata.sources).map(([key, value]) => [key, value.asOf])), counts: { CRCL: data.prices.CRCL.length, SPY: data.prices.SPY.length, usdc: data.usdc.length, rates: data.rates.length }, failures }));
// A failed refresh is visible in CI and metadata; an older valid cache remains readable.
if (failures) process.exitCode = 1;
