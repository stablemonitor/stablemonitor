import { randomUUID } from 'node:crypto';
import * as filesystem from 'node:fs/promises';
import path from 'node:path';
import {MARKET_SOURCE_MAX_AGE_DAYS} from '../assets/crcl-data-health.js';

export const SOURCE_KEYS = Object.freeze(['CRCL', 'SPY', 'usdc', 'totalStablecoins', 'rates']);
const DAY = 86400000;
const AUTHORITIES = {
  CRCL: 'third_party_market_data', SPY: 'third_party_market_data',
  usdc: 'third_party_onchain_aggregation', totalStablecoins: 'third_party_onchain_aggregation',
  rates: 'official_primary_NYFed'
};
const MAX_AGE_DAYS = MARKET_SOURCE_MAX_AGE_DAYS;
const MINIMUM_ROWS = Object.freeze({ CRCL: 30, SPY: 200, usdc: 120, totalStablecoins: 120, rates: 30 });

// Number(null), Number('') and Number(false) would invent observations.
export function strictNumber(value, label = 'number') {
  if (typeof value !== 'number' && typeof value !== 'string') throw new Error(`${label}: missing or non-numeric value`);
  if (typeof value === 'string' && !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim())) throw new Error(`${label}: invalid numeric string`);
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${label}: non-finite value`);
  return number;
}

export function strictDate(value, label = 'date') {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${label}: expected YYYY-MM-DD`);
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw new Error(`${label}: invalid calendar date`);
  return value;
}

function checkedNow(now) {
  const date = now instanceof Date ? new Date(now.getTime()) : new Date(now);
  if (!Number.isFinite(date.getTime())) throw new Error('Invalid refresh time');
  return date;
}

export function easternParts(now) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(checkedNow(now));
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return { date: `${values.year}-${values.month}-${values.day}`, minutes: Number(values.hour) * 60 + Number(values.minute) };
}

export function sourceURLs(now = new Date()) {
  return {
    CRCL: 'https://query2.finance.yahoo.com/v8/finance/chart/CRCL?range=2y&interval=1d',
    SPY: 'https://query2.finance.yahoo.com/v8/finance/chart/SPY?range=2y&interval=1d',
    usdc: 'https://stablecoins.llama.fi/stablecoincharts/all?stablecoin=2',
    totalStablecoins: 'https://stablecoins.llama.fi/stablecoincharts/all',
    rates: `https://markets.newyorkfed.org/api/rates/secured/sofr/search.json?startDate=2025-01-01&endDate=${easternParts(now).date}`
  };
}

function unixDate(value, label, { eastern = false } = {}) {
  const seconds = strictNumber(value, label);
  if (!Number.isInteger(seconds) || seconds < 0 || seconds > 9999999999) throw new Error(`${label}: invalid Unix seconds`);
  const date = new Date(seconds * 1000);
  if (!Number.isFinite(date.getTime())) throw new Error(`${label}: invalid timestamp`);
  return eastern ? easternParts(date).date : date.toISOString().slice(0, 10);
}

function notFuture(date, today, label) {
  if (date > today) throw new Error(`${label}: future observation ${date}`);
}

function closedDate(date, now) {
  return date < now.date || (date === now.date && now.minutes >= 16 * 60 + 15);
}

function sortedUnique(rows, label) {
  if (!rows.length) throw new Error(`${label}: empty usable history`);
  rows.sort((a, b) => a.date.localeCompare(b.date));
  for (let index = 1; index < rows.length; index++) {
    if (rows[index].date === rows[index - 1].date) throw new Error(`${label}: duplicate date ${rows[index].date}`);
  }
  return rows;
}

function validatedBar(row, label) {
  const date = strictDate(row?.date, `${label} date`);
  const bar = { date };
  for (const field of ['open', 'high', 'low', 'close', 'volume']) bar[field] = strictNumber(row[field], `${label} ${date} ${field}`);
  if (['open', 'high', 'low', 'close'].some(field => bar[field] <= 0)) throw new Error(`${label} ${date}: prices must be positive`);
  if (!Number.isInteger(bar.volume) || bar.volume < 0) throw new Error(`${label} ${date}: invalid volume`);
  if (bar.high < Math.max(bar.open, bar.close) || bar.low > Math.min(bar.open, bar.close) || bar.high < bar.low) throw new Error(`${label} ${date}: inconsistent OHLC`);
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
  if (weekday === 0 || weekday === 6) throw new Error(`${label} ${date}: weekend market bar`);
  bar.adjustedClose = row.adjustedClose == null ? null : strictNumber(row.adjustedClose, `${label} ${date} adjustedClose`);
  if (bar.adjustedClose !== null && bar.adjustedClose <= 0) throw new Error(`${label} ${date}: invalid adjustedClose`);
  return bar;
}

export function parsePrices(raw, { now = new Date(), ticker = 'prices' } = {}) {
  const current = easternParts(now);
  const result = raw?.chart?.result?.[0];
  const timestamps = result?.timestamp;
  const quote = result?.indicators?.quote?.[0];
  if (raw?.chart?.error || !Array.isArray(timestamps) || !timestamps.length || !quote) throw new Error(`${ticker}: empty or invalid Yahoo response`);
  for (const field of ['open', 'high', 'low', 'close', 'volume']) {
    if (!Array.isArray(quote[field]) || quote[field].length < timestamps.length) throw new Error(`${ticker}: incomplete ${field} vector`);
  }
  const adjusted = result.indicators.adjclose?.[0]?.adjclose;
  if (adjusted != null && (!Array.isArray(adjusted) || adjusted.length < timestamps.length)) throw new Error(`${ticker}: incomplete adjustedClose vector`);
  const bars = [];
  for (let index = 0; index < timestamps.length; index++) {
    const date = unixDate(timestamps[index], `${ticker} timestamp`, { eastern: true });
    notFuture(date, current.date, ticker);
    // Exclude the current session before the close buffer, even if its quotes look complete.
    if (!closedDate(date, current)) continue;
    bars.push(validatedBar({ date, ...Object.fromEntries(['open', 'high', 'low', 'close', 'volume'].map(field => [field, quote[field][index]])), adjustedClose: adjusted?.[index] ?? null }, ticker));
  }
  return sortedUnique(bars, ticker);
}

function parseChain(raw, field, output, { now = new Date(), label = output } = {}) {
  const today = easternParts(now).date;
  const utcToday = checkedNow(now).toISOString().slice(0, 10);
  if (!Array.isArray(raw) || !raw.length) throw new Error(`${label}: empty or invalid chain history`);
  const rows = [];
  for (const row of raw) {
    const date = unixDate(row?.date, `${label} date`);
    // Chain timestamps are UTC dates. The early UTC day can precede midnight in New York.
    notFuture(date, utcToday, label);
    if (date >= today) continue;
    const amount = strictNumber(row?.[field]?.peggedUSD, `${label} ${date} ${field}.peggedUSD`);
    if (amount < 0) throw new Error(`${label} ${date}: negative supply`);
    if (amount > 0) rows.push({ date, [output]: amount });
  }
  return sortedUnique(rows, label);
}

export function parseUSDCSupply(raw, options) {
  // Reserve income is earned on nominal units, not a depeg-adjusted USD price.
  const nominal = parseChain(raw, 'totalCirculating', 'usdc', options);
  const valued = new Map(parseChain(raw, 'totalCirculatingUSD', 'usdcUSD', options).map(row => [row.date, row.usdcUSD]));
  return nominal.map(row => {
    const usdcUSD = valued.get(row.date);
    if (!usdcUSD) throw new Error(`usdc ${row.date}: missing positive USD-valued numerator`);
    return { ...row, usdcUSD };
  });
}

export function parseUSDStablecoinSupply(raw, options) {
  // Other currency pegs are outside the USD-only market-share universe.
  return parseChain(raw, 'totalCirculatingUSD', 'totalStablecoins', options);
}

function validatedRate(row, label) {
  const date = strictDate(row?.date, `${label} effectiveDate`);
  const sofr = strictNumber(row?.sofr, `${label} ${date} SOFR`);
  if (sofr < 0 || sofr > 0.25) throw new Error(`${label} ${date}: SOFR outside 0%-25% validation range`);
  return { date, sofr, source: 'NYFed', publicationPolicy: 'next_business_morning; model uses no rate dated current valuation day' };
}

export function parseRates(raw, { now = new Date() } = {}) {
  const today = easternParts(now).date;
  if (!Array.isArray(raw?.refRates) || !raw.refRates.length) throw new Error('rates: empty or invalid NY Fed refRates array');
  const rates = [];
  for (const row of raw.refRates) {
    if (row?.type !== 'SOFR') continue;
    const date = strictDate(row.effectiveDate, 'rates effectiveDate');
    notFuture(date, today, 'rates');
    const rate = validatedRate({ date, sofr: strictNumber(row.percentRate, `rates ${date} percentRate`) / 100 }, 'rates');
    if (date < today) rates.push(rate);
  }
  return sortedUnique(rates, 'rates');
}

const daysBetween = (first, last) => (Date.parse(`${last}T00:00:00Z`) - Date.parse(`${first}T00:00:00Z`)) / DAY;
const datePlus = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);

function assertHistory(incoming, previous, key) {
  if (incoming.length < MINIMUM_ROWS[key]) throw new Error(`${key}: too little history (${incoming.length}; minimum ${MINIMUM_ROWS[key]})`);
  if (!previous.length) return;
  if (incoming.at(-1).date < previous.at(-1).date) throw new Error(`${key}: latest date regressed from ${previous.at(-1).date} to ${incoming.at(-1).date}`);
  const elapsed = Math.max(0, daysBetween(previous.at(-1).date, incoming.at(-1).date));
  // Yahoo deliberately slides a two-year window; chain and rate requests cover fixed full histories.
  const isPrice = key === 'CRCL' || key === 'SPY';
  const retainedStart = datePlus(previous[0].date, isPrice ? elapsed + 7 : 7);
  const rollingStart = datePlus(incoming.at(-1).date, -720);
  const allowedStart = isPrice && rollingStart > retainedStart ? rollingStart : retainedStart;
  if (previous.length >= 20 && incoming[0].date > allowedStart) throw new Error(`${key}: truncated beginning of history`);
  const overlap = previous.filter(row => row.date >= incoming[0].date && row.date <= incoming.at(-1).date);
  if (incoming.length < Math.ceil(overlap.length * 0.9)) throw new Error(`${key}: truncated history (${incoming.length} versus ${overlap.length} previous observations)`);
  const recentPrevious = previous.filter(row => row.date >= datePlus(previous.at(-1).date, -120));
  const dates = new Set(incoming.map(row => row.date));
  if (recentPrevious.some(row => !dates.has(row.date))) throw new Error(`${key}: recent historical observations disappeared`);
}

function mergeHistory(previous, incoming) {
  return [...new Map([...previous, ...incoming].map(row => [row.date, row])).values()].sort((a, b) => a.date.localeCompare(b.date));
}

function validatedCache(previous, key, now) {
  const current = easternParts(now);
  const raw = key === 'CRCL' || key === 'SPY' ? previous.prices?.[key] : key === 'rates' ? previous.rates : previous.usdc;
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error(`Existing cached ${key} history is not an array; previous snapshot must be preserved`);
  if (!raw.length) return [];
  try {
    const rows = raw.map(row => {
      if (key === 'CRCL' || key === 'SPY') return validatedBar(row, `cached ${key}`);
      if (key === 'rates') return validatedRate(row, 'cached rates');
      const date = strictDate(row?.date, `cached ${key} date`);
      const rawAmount = row?.[key === 'usdc' ? 'usdc' : 'totalStablecoins'];
      if (key === 'totalStablecoins' && rawAmount == null && date < datePlus(raw.at(-1).date, -120)) return null;
      const amount = strictNumber(rawAmount, `cached ${key} supply`);
      if (amount <= 0) throw new Error(`cached ${key}: non-positive supply`);
      if (key === 'usdc') {
        const usdcUSD = row.usdcUSD == null ? null : strictNumber(row.usdcUSD, 'cached USD-valued USDC supply');
        if (usdcUSD !== null && usdcUSD <= 0) throw new Error('cached usdcUSD: non-positive supply');
        return { date, usdc: amount, usdcUSD };
      }
      return { date, [key]: amount };
    });
    const usable = rows.filter(Boolean);
    usable.forEach(row => notFuture(row.date, current.date, `cached ${key}`));
    return sortedUnique(usable.filter(row => key === 'CRCL' || key === 'SPY' ? closedDate(row.date, current) : row.date < current.date), `cached ${key}`);
  } catch (error) {
    throw new Error(`Existing cached ${key} history is invalid; previous snapshot must be preserved: ${error.message}`, { cause: error });
  }
}

function validTimestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 19) === value.slice(0, 19) ? value : null;
}

function previousSuccess(previous, key) {
  const source = previous.metadata?.sources?.[key];
  return validTimestamp(source?.cacheFetchedAt) || validTimestamp(source?.lastSuccessfulFetchedAt) || (source?.status !== 'cached' && source?.status !== 'failed' ? validTimestamp(source?.fetchedAt) : null);
}

function joinChain(usdc, totals) {
  if (!usdc.length || !totals.length) throw new Error('Both USDC numerator and USD-stablecoin denominator are required');
  const byDate = new Map(totals.map(row => [row.date, row.totalStablecoins]));
  const latest = usdc.at(-1).date;
  if (!byDate.has(latest)) throw new Error(`USD-stablecoin denominator missing for latest USDC date ${latest}`);
  return usdc.map(row => {
    const totalStablecoins = byDate.get(row.date) ?? null;
    if (totalStablecoins !== null && row.usdcUSD !== null && totalStablecoins < row.usdcUSD) throw new Error(`USD-stablecoin denominator smaller than USD-valued USDC on ${row.date}`);
    if (row.date >= datePlus(latest, -120) && totalStablecoins === null) throw new Error(`USD-stablecoin denominator missing on ${row.date}`);
    return { ...row, totalStablecoins };
  });
}

/** Pure snapshot builder. Importing this module never fetches or changes files. */
export function buildSnapshot({ raw = {}, errors = {}, previous = {}, now = new Date() } = {}) {
  now = checkedNow(now);
  const fetchedAt = now.toISOString(), current = easternParts(now), urls = sourceURLs(now);
  const metadata = {
    generatedAt: fetchedAt, currentEasternDate: current.date, currentEasternTimeMinutes: current.minutes,
    closingPolicy: 'America/New_York timezone including DST; current-day bars excluded until 16:15 ET. Chain supply and SOFR are lagged by at least one calendar day.',
    pricesPolicy: 'Complete raw daily OHLC and volume; adjustedClose retained for audit. Scoring uses raw tradable prices without dividend reinvestment.',
    stablecoinPolicy: 'USDC reserve anchor usdc is nominal totalCirculating.peggedUSD. Market-share numerator usdcUSD and denominator totalStablecoins both use totalCirculatingUSD.peggedUSD for the USD-pegged universe; other currency pegs are excluded. Source history may be revised.',
    freshnessPolicy: { maximumCalendarAgeDays: MAX_AGE_DAYS, minimumHistoryRows: MINIMUM_ROWS }, sources: {}
  };
  const data = { schemaVersion: 1, prices: { CRCL: [], SPY: [] }, usdc: [], rates: [], metadata };
  const cache = Object.fromEntries(SOURCE_KEYS.map(key => [key, validatedCache(previous, key, now)]));
  function record(key, rows, status = 'fresh', error = null) {
    const asOf = rows.at(-1)?.date ?? null;
    if (status === 'fresh' && daysBetween(asOf, current.date) > MAX_AGE_DAYS[key]) {
      status = 'stale'; error = `${key}: latest observation ${asOf} exceeds ${MAX_AGE_DAYS[key]} calendar days`;
    }
    const successful = status === 'fresh' || status === 'stale';
    metadata.sources[key] = {
      status, fetchedAt, asOf, error, url: urls[key], authority: AUTHORITIES[key],
      cacheFetchedAt: successful ? fetchedAt : previousSuccess(previous, key),
      lastSuccessfulFetchedAt: successful ? fetchedAt : previousSuccess(previous, key), observations: rows.length
    };
  }
  function failure(key, error) { record(key, cache[key], cache[key].length ? 'cached' : 'failed', String(error?.message || error)); }
  function requireRaw(key) {
    if (Object.hasOwn(errors, key)) throw new Error(String(errors[key]?.message || errors[key]));
    if (!Object.hasOwn(raw, key) || raw[key] == null) throw new Error(`${key}: source response unavailable`);
    return raw[key];
  }
  for (const ticker of ['CRCL', 'SPY']) {
    try {
      const rows = parsePrices(requireRaw(ticker), { now, ticker });
      assertHistory(rows, cache[ticker], ticker);
      data.prices[ticker] = mergeHistory(cache[ticker], rows);
      record(ticker, data.prices[ticker]);
    } catch (error) { data.prices[ticker] = cache[ticker]; failure(ticker, error); }
  }
  try {
    const numerator = parseUSDCSupply(requireRaw('usdc'), { now });
    const denominator = parseUSDStablecoinSupply(requireRaw('totalStablecoins'), { now });
    assertHistory(numerator, cache.usdc, 'usdc');
    assertHistory(denominator, cache.totalStablecoins, 'totalStablecoins');
    data.usdc = joinChain(mergeHistory(cache.usdc, numerator), mergeHistory(cache.totalStablecoins, denominator));
    record('usdc', numerator); record('totalStablecoins', denominator);
  } catch (error) {
    try { data.usdc = joinChain(cache.usdc, cache.totalStablecoins); } catch { data.usdc = []; cache.usdc = []; cache.totalStablecoins = []; }
    failure('usdc', error); failure('totalStablecoins', error);
  }
  const nominalSupply = metadata.sources.usdc.status === 'fresh' || metadata.sources.usdc.status === 'stale';
  const previousBasis = previous.metadata?.sources?.usdc?.valueBasis;
  metadata.sources.usdc.inputField = nominalSupply ? 'totalCirculating.peggedUSD' : previous.metadata?.sources?.usdc?.inputField ?? 'unknown_cached_field';
  metadata.sources.usdc.valueBasis = nominalSupply ? 'nominal_USDC_units' : previousBasis ?? 'legacy_USD_valued_cache';
  metadata.sources.usdc.cachedLegacyValueBasis = !nominalSupply && !previousBasis;
  metadata.sources.usdc.marketShareInputField = 'totalCirculatingUSD.peggedUSD';
  metadata.sources.usdc.marketShareValueBasis = 'USD_market_value_USD_pegs_only';
  metadata.sources.totalStablecoins.inputField = 'totalCirculatingUSD.peggedUSD';
  metadata.sources.totalStablecoins.universe = 'USD_pegged_stablecoins_only';
  metadata.sources.totalStablecoins.valueBasis = 'USD_market_value_USD_pegs_only';
  metadata.sources.totalStablecoins.excludes = ['peggedEUR', 'peggedGBP', 'other_non_USD_pegs'];
  try {
    const rows = parseRates(requireRaw('rates'), { now });
    assertHistory(rows, cache.rates, 'rates');
    data.rates = mergeHistory(cache.rates, rows); record('rates', data.rates);
  } catch (error) { data.rates = cache.rates; failure('rates', error); }
  metadata.failures = SOURCE_KEYS.filter(key => metadata.sources[key].status !== 'fresh').length;
  metadata.degraded = metadata.failures > 0; metadata.status = metadata.degraded ? 'degraded' : 'fresh';
  const latest = data.usdc.at(-1);
  metadata.headSummary = {
    date: latest?.date ?? null, asOf: latest?.date ?? null,
    totalUSDC: metadata.sources.usdc.valueBasis === 'nominal_USDC_units' ? latest?.usdc ?? null : null,
    totalUSDCUSD: latest?.usdcUSD ?? null, totalStable: latest?.totalStablecoins ?? null,
    marketShare: latest?.totalStablecoins && latest?.usdcUSD ? latest.usdcUSD / latest.totalStablecoins : null,
    numeratorSource: 'usdc', denominatorSource: 'totalStablecoins',
    reserveValueBasis: metadata.sources.usdc.valueBasis,
    numeratorValueBasis: metadata.sources.usdc.marketShareValueBasis,
    denominatorValueBasis: metadata.sources.totalStablecoins.valueBasis,
    status: ['usdc', 'totalStablecoins'].every(key => metadata.sources[key].status === 'fresh') ? 'fresh' : metadata.sources.usdc.status
  };
  return data;
}

/** Same-directory rename prevents an interrupted write from replacing good JSON. */
export async function writeSnapshotAtomic(target, data, { fs = filesystem, token = randomUUID() } = {}) {
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${token}.tmp`);
  let originalError, handle, temporaryOwned = false;
  try {
    const payload = `${JSON.stringify(data, null, 2)}\n`;
    handle = await fs.open(temporary, 'wx', 0o644);
    temporaryOwned = true;
    await handle.writeFile(payload);
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporary, target);
  } catch (error) { originalError = error; throw error; }
  finally {
    if (handle) {
      try { await handle.close(); } catch (error) { if (!originalError) throw error; }
    }
    if (temporaryOwned) {
      try { await fs.unlink(temporary); } catch (error) { if (error.code !== 'ENOENT' && !originalError) throw error; }
    }
  }
}
