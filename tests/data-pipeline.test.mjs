import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildSnapshot, easternParts, parsePrices, parseRates, parseUSDCSupply, parseUSDStablecoinSupply, SOURCE_KEYS, strictDate, strictNumber, writeSnapshotAtomic } from '../scripts/market-data.mjs';
import { fetchJSON, refreshData } from '../scripts/update-data.mjs';

const NOW = new Date('2026-10-02T12:00:00.000Z');
const latest = '2026-10-01';
const dateAt = (date, delta) => new Date(Date.parse(`${date}T00:00:00Z`) + delta * 86400000).toISOString().slice(0, 10);
const unix = date => Date.parse(`${date}T14:30:00Z`) / 1000;
function weekdays(end, count) {
  const dates = [];
  for (let index = 0; dates.length < count; index++) {
    const date = dateAt(end, -index), weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
    if (weekday !== 0 && weekday !== 6) dates.unshift(date);
  }
  return dates;
}
function priceRaw(dates) {
  return { chart: { result: [{ timestamp: dates.map(unix), indicators: { quote: [{ open: dates.map(() => 100), high: dates.map(() => 103), low: dates.map(() => 98), close: dates.map(() => 101), volume: dates.map(() => 10000) }], adjclose: [{ adjclose: dates.map(() => 101) }] } }], error: null } };
}
function fixtures(end = latest) {
  const dates = Array.from({ length: 400 }, (_, index) => dateAt(end, index - 399));
  return {
    CRCL: priceRaw(weekdays(end, 220)), SPY: priceRaw(weekdays(end, 220)),
    usdc: dates.map(date => ({ date: Date.parse(`${date}T00:00:00Z`) / 1000, totalCirculating: { peggedUSD: 80000000000 }, totalCirculatingUSD: { peggedUSD: 72000000000 } })),
    totalStablecoins: dates.map(date => ({ date: Date.parse(`${date}T00:00:00Z`) / 1000, totalCirculatingUSD: { peggedUSD: 240000000000, peggedEUR: 10000000000 } })),
    rates: { refRates: weekdays(end, 220).map(effectiveDate => ({ effectiveDate, percentRate: '4.0', type: 'SOFR' })) }
  };
}

function freshSnapshot() {
  const data = buildSnapshot({ raw: fixtures(), now: NOW });
  assert.equal(data.metadata.status, 'fresh');
  return data;
}

test('Strict numbers never turn missing, blank or boolean values into zero', () => {
  for (const value of [null, undefined, '', ' ', true, false, NaN, Infinity, '0x10', '4%']) assert.throws(() => strictNumber(value));
  for (const value of [0, '0', '4.25', ' 4.25 ']) assert.equal(strictNumber(value), Number(value));
});

test('Calendar dates reject nonexistent dates and loose formats', () => {
  for (const date of [null, undefined, '', '2026-02-30', '2026-2-3', '2026-13-01', true]) assert.throws(() => strictDate(date));
  assert.equal(strictDate('2024-02-29'), '2024-02-29');
});

test('SOFR rejects missing values, malformed/future effective dates and unreasonable ranges; genuine zero remains zero', () => {
  const response = percentRate => ({ refRates: [{ effectiveDate: latest, type: 'SOFR', percentRate }] });
  for (const value of [null, undefined, '', ' ', true, false, '-1', '25.01']) assert.throws(() => parseRates(response(value), { now: NOW }));
  assert.equal(parseRates(response('0'), { now: NOW })[0].sofr, 0);
  for (const effectiveDate of [null, undefined, '', '2026-02-30', '2026-10-03']) assert.throws(() => parseRates({ refRates: [{ effectiveDate, type: 'SOFR', percentRate: 4 }] }, { now: NOW }));
  assert.throws(() => parseRates({ refRates: [] }, { now: NOW }));
  assert.throws(() => parseRates({ refRates: [{ effectiveDate: latest, percentRate: 4 }] }, { now: NOW }));
});

test('Daily price parser respects the New York close buffer and DST', () => {
  assert.deepEqual(easternParts('2026-03-06T21:14:00Z'), { date: '2026-03-06', minutes: 974 });
  assert.deepEqual(easternParts('2026-03-09T20:14:00Z'), { date: '2026-03-09', minutes: 974 });
  const winter = priceRaw(['2026-03-05', '2026-03-06']);
  assert.deepEqual(parsePrices(winter, { now: new Date('2026-03-06T21:14:00Z') }).map(row => row.date), ['2026-03-05']);
  assert.equal(parsePrices(winter, { now: new Date('2026-03-06T21:15:00Z') }).at(-1).date, '2026-03-06');
  const summer = priceRaw(['2026-03-06', '2026-03-09']);
  assert.deepEqual(parsePrices(summer, { now: new Date('2026-03-09T20:14:00Z') }).map(row => row.date), ['2026-03-06']);
  assert.equal(parsePrices(summer, { now: new Date('2026-03-09T20:15:00Z') }).at(-1).date, '2026-03-09');
  const afterMidnightUTC = priceRaw(['2026-10-01']);
  afterMidnightUTC.chart.result[0].timestamp = [Date.parse('2026-10-02T00:05:00Z') / 1000];
  assert.equal(parsePrices(afterMidnightUTC, { now: NOW })[0].date, '2026-10-01');
});

test('Complete daily bars require every OHLC/volume field and consistent high/low bounds', () => {
  for (const [field, value] of [['open', null], ['close', ''], ['high', 99], ['low', 102], ['volume', null], ['volume', -1], ['volume', 1.2]]) {
    const raw = priceRaw([latest]); raw.chart.result[0].indicators.quote[0][field][0] = value;
    assert.throws(() => parsePrices(raw, { now: NOW }));
  }
  const short = priceRaw([latest]); short.chart.result[0].indicators.quote[0].open = [];
  assert.throws(() => parsePrices(short, { now: NOW }), /incomplete/);
  assert.throws(() => parsePrices(priceRaw(['2026-10-05']), { now: NOW }), /future/);
  assert.throws(() => parsePrices(priceRaw(['2026-09-27']), { now: NOW }), /weekend/);
});

test('USDC reserve anchor uses nominal units and denominator excludes non-USD pegs', () => {
  const raw = fixtures();
  assert.equal(parseUSDCSupply(raw.usdc, { now: NOW }).at(-1).usdc, 80000000000);
  assert.equal(parseUSDCSupply(raw.usdc, { now: NOW }).at(-1).usdcUSD, 72000000000);
  assert.equal(parseUSDStablecoinSupply(raw.totalStablecoins, { now: NOW }).at(-1).totalStablecoins, 240000000000);
  const data = freshSnapshot();
  assert.equal(data.usdc.at(-1).usdcUSD / data.usdc.at(-1).totalStablecoins, .3);
  assert.equal(data.metadata.sources.usdc.inputField, 'totalCirculating.peggedUSD');
  assert.equal(data.metadata.sources.totalStablecoins.universe, 'USD_pegged_stablecoins_only');
  assert.equal(data.metadata.headSummary.totalUSDC, 80000000000);
  assert.equal(data.metadata.headSummary.totalUSDCUSD, 72000000000);
  assert.equal(data.metadata.headSummary.marketShare, .3);
});

test('UTC chain day ahead of the current Eastern day is lagged, not mislabelled as a future response', () => {
  for (const { utcDate, midnightHour } of [{ utcDate: '2026-10-02', midnightHour: 4 }, { utcDate: '2026-01-15', midnightHour: 5 }]) {
    for (let hour = 0; hour <= midnightHour; hour++) {
      const now = new Date(`${utcDate}T${String(hour).padStart(2, '0')}:00:00Z`);
      const expected = dateAt(utcDate, hour < midnightHour ? -2 : -1);
      const raw = fixtures(utcDate);
      assert.equal(parseUSDCSupply(raw.usdc, { now }).at(-1).date, expected);
      assert.equal(parseUSDStablecoinSupply(raw.totalStablecoins, { now }).at(-1).date, expected);
      // Unconsumed new UTC-day rows can still be incomplete while the source assembles them.
      raw.usdc.at(-1).totalCirculating.peggedUSD = null;
      raw.usdc.at(-1).totalCirculatingUSD.peggedUSD = null;
      raw.totalStablecoins.at(-1).totalCirculatingUSD.peggedUSD = null;
      assert.equal(parseUSDCSupply(raw.usdc, { now }).at(-1).date, expected);
      assert.equal(parseUSDStablecoinSupply(raw.totalStablecoins, { now }).at(-1).date, expected);
      const future = fixtures(dateAt(utcDate, 1));
      assert.throws(() => parseUSDCSupply(future.usdc, { now }), /future/);
      assert.throws(() => parseUSDStablecoinSupply(future.totalStablecoins, { now }), /future/);
    }
  }
});

test('Five successful source records always include status, timestamps, asOf and explicit error', () => {
  const data = freshSnapshot();
  assert.deepEqual(Object.keys(data.metadata.sources).sort(), [...SOURCE_KEYS].sort());
  assert.equal(data.metadata.degraded, false);
  for (const source of Object.values(data.metadata.sources)) {
    assert.equal(source.status, 'fresh'); assert.equal(source.fetchedAt, NOW.toISOString());
    assert.equal(source.asOf, latest); assert.equal(source.error, null); assert.ok(source.url.startsWith('https://'));
  }
});

test('Missing USD-valued USDC numerator cannot receive fresh status even when nominal supply exists', () => {
  const previous = freshSnapshot();
  for (const value of [null, undefined, '', false, 0]) {
    const raw = fixtures(); raw.usdc.at(-1).totalCirculatingUSD.peggedUSD = value;
    const data = buildSnapshot({ raw, previous, now: NOW });
    assert.equal(data.metadata.sources.usdc.status, 'cached');
    assert.deepEqual(data.usdc, previous.usdc);
  }
});

test('Empty denominator and missing latest denominator cannot be marked fresh; prior paired history remains cached', () => {
  const previous = freshSnapshot();
  for (const mutation of [raw => { raw.totalStablecoins = []; }, raw => { raw.totalStablecoins.pop(); }, raw => { raw.totalStablecoins.at(-1).totalCirculatingUSD.peggedUSD = null; }]) {
    const raw = fixtures(); mutation(raw);
    const data = buildSnapshot({ raw, previous, now: NOW });
    assert.deepEqual(data.usdc, previous.usdc);
    assert.equal(data.metadata.sources.usdc.status, 'cached');
    assert.equal(data.metadata.sources.totalStablecoins.status, 'cached');
    assert.equal(data.metadata.status, 'degraded');
    assert.equal(data.metadata.sources.usdc.cacheFetchedAt, previous.metadata.sources.usdc.fetchedAt);
    assert.ok(data.metadata.sources.totalStablecoins.error);
  }
});

test('Null SOFR refresh keeps the previous series and last successful fetch time across repeated failures', () => {
  const previous = freshSnapshot();
  const raw = fixtures(); raw.rates.refRates.at(-1).percentRate = null;
  const once = buildSnapshot({ raw, previous, now: new Date('2026-10-03T12:00:00Z') });
  const twice = buildSnapshot({ raw, previous: once, now: new Date('2026-10-04T12:00:00Z') });
  assert.deepEqual(twice.rates, previous.rates);
  assert.equal(twice.metadata.sources.rates.status, 'cached');
  assert.equal(twice.metadata.sources.rates.cacheFetchedAt, NOW.toISOString());
  assert.equal(twice.metadata.sources.rates.fetchedAt, '2026-10-04T12:00:00.000Z');
});

test('Regressed, truncated and very short responses preserve older histories', () => {
  const previous = freshSnapshot();
  const raw = fixtures('2026-09-30');
  const regressed = buildSnapshot({ raw, previous, now: NOW });
  assert.equal(regressed.metadata.sources.CRCL.status, 'cached');
  assert.match(regressed.metadata.sources.CRCL.error, /regressed/);
  assert.deepEqual(regressed.prices.CRCL, previous.prices.CRCL);
  const short = fixtures(); short.SPY = priceRaw(weekdays(latest, 3)); short.usdc = short.usdc.slice(-140);
  const truncated = buildSnapshot({ raw: short, previous, now: NOW });
  assert.equal(truncated.metadata.sources.SPY.status, 'cached');
  assert.equal(truncated.metadata.sources.usdc.status, 'cached');
  assert.deepEqual(truncated.usdc, previous.usdc);
  const holes = fixtures(); holes.rates.refRates.splice(-15, 1);
  assert.equal(buildSnapshot({ raw: holes, previous, now: NOW }).metadata.sources.rates.status, 'cached');
});

test('An invalid previous row never disables the history fence or overwrites the old snapshot', () => {
  const raw = fixtures(); raw.CRCL = priceRaw(weekdays(latest, 30)); raw.usdc = raw.usdc.slice(-120);
  for (const corrupt of [data => { data.prices.CRCL[0].volume = null; }, data => { data.usdc[0].usdc = null; }, data => { data.rates[0].sofr = ''; }]) {
    const previous = freshSnapshot(); corrupt(previous);
    assert.throws(() => buildSnapshot({ raw, previous, now: NOW }), /Existing cached .* is invalid; previous snapshot must be preserved/);
  }
});

test('Old but parseable observations become stale and a fresh fetch cannot hide their age', () => {
  const data = buildSnapshot({ raw: fixtures('2026-09-18'), now: NOW });
  assert.equal(data.metadata.status, 'degraded');
  for (const source of Object.values(data.metadata.sources)) assert.equal(source.status, 'stale');
  assert.equal(data.metadata.sources.rates.asOf, '2026-09-18');
});

test('Unknown empty response shapes fail safely and expose all five failed source states', () => {
  const data = buildSnapshot({ raw: Object.fromEntries(SOURCE_KEYS.map(key => [key, {}])), now: NOW });
  assert.equal(data.metadata.failures, 5); assert.equal(data.metadata.degraded, true);
  for (const source of Object.values(data.metadata.sources)) {
    assert.equal(source.status, 'failed'); assert.equal(source.asOf, null); assert.ok(source.error);
  }
});

test('Legacy cached USDC valuation basis remains explicitly labelled when refresh fails', () => {
  const previous = freshSnapshot();
  delete previous.metadata.sources.usdc.valueBasis; delete previous.metadata.sources.usdc.inputField;
  const data = buildSnapshot({ previous, errors: Object.fromEntries(SOURCE_KEYS.map(key => [key, 'offline'])), now: NOW });
  assert.equal(data.metadata.sources.usdc.status, 'cached');
  assert.equal(data.metadata.sources.usdc.valueBasis, 'legacy_USD_valued_cache');
  assert.equal(data.metadata.sources.usdc.cachedLegacyValueBasis, true);
  assert.equal(data.metadata.headSummary.totalUSDC, null);
});

test('Network retry uses bounded exponential backoff and never turns a final failure into success', async () => {
  const delays = []; let calls = 0;
  const data = await fetchJSON('https://example.invalid/data', { fetchImpl: async () => { calls++; if (calls < 3) throw new Error('temporary'); return { ok: true, json: async () => ({ done: true }) }; }, sleep: async delay => delays.push(delay), jitter: () => 0 });
  assert.deepEqual(data, { done: true }); assert.equal(calls, 3); assert.deepEqual(delays, [750, 1500]);
  await assert.rejects(fetchJSON('https://example.invalid/data', { fetchImpl: async () => ({ ok: false, status: 503 }), sleep: async () => {}, jitter: () => 0 }), /HTTP 503/);
});

test('Atomic writer replaces a complete JSON file and removes its temporary file', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'stablemonitor-atomic-'));
  try {
    const target = path.join(directory, 'snapshot.json'); await fs.writeFile(target, '{"old":true}\n');
    await writeSnapshotAtomic(target, { good: true }, { token: 'success' });
    assert.deepEqual(JSON.parse(await fs.readFile(target, 'utf8')), { good: true });
    assert.deepEqual(await fs.readdir(directory), ['snapshot.json']);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('Atomic rename failure and interrupted temporary write do not destroy the previous file', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'stablemonitor-atomic-failure-'));
  try {
    const target = path.join(directory, 'snapshot.json'), original = '{"old":true}\n'; await fs.writeFile(target, original);
    await assert.rejects(writeSnapshotAtomic(target, { new: true }, { token: 'rename-failed', fs: { ...fs, rename: async () => { throw new Error('rename rejected'); } } }), /rename rejected/);
    assert.equal(await fs.readFile(target, 'utf8'), original); assert.deepEqual(await fs.readdir(directory), ['snapshot.json']);
    await assert.rejects(writeSnapshotAtomic(target, { new: true }, { token: 'write-failed', fs: { ...fs, open: async (...args) => {
      const handle = await fs.open(...args);
      return { writeFile: async content => { await handle.writeFile(content.slice(0, 10)); throw new Error('interrupted write'); }, sync: () => handle.sync(), close: () => handle.close() };
    } } }), /interrupted write/);
    assert.equal(await fs.readFile(target, 'utf8'), original); assert.deepEqual(await fs.readdir(directory), ['snapshot.json']);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('An existing temporary filename is never removed when exclusive creation fails', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'stablemonitor-collision-'));
  try {
    const target = path.join(directory, 'snapshot.json'), temporary = path.join(directory, '.snapshot.json.collision.tmp');
    await fs.writeFile(target, '{"old":true}'); await fs.writeFile(temporary, 'another writer');
    await assert.rejects(writeSnapshotAtomic(target, { new: true }, { token: 'collision' }), { code: 'EEXIST' });
    assert.equal(await fs.readFile(temporary, 'utf8'), 'another writer');
    assert.equal(await fs.readFile(target, 'utf8'), '{"old":true}');
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('Offline refresh marks caches degraded without erasing data; bad first-run responses write no file', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'stablemonitor-refresh-'));
  try {
    const target = path.join(directory, 'snapshot.json'), previous = freshSnapshot(); await fs.writeFile(target, JSON.stringify(previous));
    const data = await refreshData({ target, now: NOW, fetchImpl: async () => { throw new Error('offline'); }, sleep: async () => {}, jitter: () => 0 });
    assert.equal(data.metadata.status, 'degraded'); assert.deepEqual(data.prices, previous.prices); assert.deepEqual(data.usdc, previous.usdc); assert.deepEqual(data.rates, previous.rates);
    const blank = path.join(directory, 'first-run.json');
    await assert.rejects(refreshData({ target: blank, now: NOW, fetchImpl: async () => ({ ok: true, json: async () => ({}) }), sleep: async () => {} }), /previous file preserved/);
    await assert.rejects(fs.readFile(blank), { code: 'ENOENT' });
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('Corrupt existing JSON is preserved and rejected before any source fetch', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'stablemonitor-corrupt-'));
  try {
    const target = path.join(directory, 'snapshot.json'); await fs.writeFile(target, '{broken'); let fetched = false;
    await assert.rejects(refreshData({ target, fetchImpl: async () => { fetched = true; } }), /cannot be read safely/);
    assert.equal(fetched, false); assert.equal(await fs.readFile(target, 'utf8'), '{broken');
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
