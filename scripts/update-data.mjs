import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildSnapshot, SOURCE_KEYS, sourceURLs, writeSnapshotAtomic } from './market-data.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultTarget = path.join(root, 'data/market-data.json');

export async function fetchJSON(url, { fetchImpl = fetch, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), jitter = Math.random } = {}) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await sleep(750 * 2 ** (attempt - 1) + Math.floor(jitter() * 250));
    try {
      const response = await fetchImpl(url, {
        headers: { 'User-Agent': 'StableMonitor/1.1 public research dashboard', Accept: 'application/json' },
        signal: AbortSignal.timeout(25000)
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (error) { lastError = error; }
  }
  throw lastError;
}

export async function refreshData({ target = defaultTarget, now = new Date(), fetchImpl = fetch, sleep, jitter } = {}) {
  let previous = {};
  try { previous = JSON.parse(await readFile(target, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error(`Existing snapshot cannot be read safely: ${error.message}`, { cause: error }); }
  const sources = sourceURLs(now);
  const responses = await Promise.allSettled(SOURCE_KEYS.map(key => fetchJSON(sources[key], { fetchImpl, sleep, jitter })));
  const raw = {}, errors = {};
  responses.forEach((response, index) => {
    const key = SOURCE_KEYS[index];
    if (response.status === 'fulfilled') raw[key] = response.value;
    else errors[key] = response.reason;
  });
  const data = buildSnapshot({ raw, errors, previous, now });
  // Preserve the previous file when no complete usable snapshot can be assembled.
  if (!data.prices.CRCL.length || !data.prices.SPY.length || !data.usdc.length || !data.rates.length) {
    throw new Error(`Refresh produced no usable complete snapshot; previous file preserved. ${JSON.stringify(data.metadata.sources)}`);
  }
  await writeSnapshotAtomic(target, data);
  return data;
}

async function main() {
  try {
    const data = await refreshData();
    console.log(JSON.stringify({ status: data.metadata.status, asOf: Object.fromEntries(SOURCE_KEYS.map(key => [key, data.metadata.sources[key].asOf])), counts: { CRCL: data.prices.CRCL.length, SPY: data.prices.SPY.length, usdc: data.usdc.length, rates: data.rates.length }, failures: data.metadata.failures }));
    if (data.metadata.degraded) process.exitCode = 1;
  } catch (error) { console.error(`Market-data refresh failed: ${error.message}`); process.exitCode = 1; }
}

// Importing the entry point in tests does not make network requests or writes.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
