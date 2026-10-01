/**
 * Independent, deliberately interpretable CRCL scenario model.
 * Dollar amounts are USD, share counts are actual counts, rates are decimals.
 * Signals are conditional research candidates, not predictions or instructions.
 */
export const MODEL_VERSION = '1.1.0-pit';
export const HISTORICAL_FORMULA_VERSION = '1.0.0-reconstructed';
export const DEFAULT_SETTINGS = Object.freeze({
  scenarios: Object.freeze({
    bear: Object.freeze({ usdcGrowth: -0.10, yieldShift: -0.012, retentionShift: -0.02, otherGrowth: 0.05, opexGrowth: 0.15, dilution: 0.08, multiple: 14 }),
    base: Object.freeze({ usdcGrowth: 0.15, yieldShift: -0.006, retentionShift: 0, otherGrowth: 0.20, opexGrowth: 0.10, dilution: 0.04, multiple: 22 }),
    bull: Object.freeze({ usdcGrowth: 0.35, yieldShift: 0, retentionShift: 0.03, otherGrowth: 0.45, opexGrowth: 0.08, dilution: 0.02, multiple: 30 })
  }),
  reserveYieldOverride: null, reserveRetentionOverride: null,
  annualOpexOverride: null, dilutedSharesOverride: null,
  annualRecurringOtherRevenueOverride: null, otherContributionMarginOverride: null,
  corporateNetCashOverride: null, futureCapitalCommitmentsOverride: null,
  valuationMethod: 'retained-reserve', compensationMode: 'equity',
  annualSBCPayrollTaxOverride: null, annualRecurringSBCOverride: null, financingDilution: 0,
  opexIncludesSBCPayrollTax: false,
  eventRisk: 'normal', depeg: false,
  buyThreshold: 70, sellThreshold: 65, cooldownSessions: 10,
  initialCash: 100000, maxAllocation: 0.60, trancheFraction: 0.15,
  slippageBps: 10, feeBps: 5
});
// The original research baseline is frozen. It was reconstructed from archived
// observations, not an already-operating live strategy or a historical vendor tape.
export const HISTORICAL_SETTINGS_V1 = Object.freeze({ ...DEFAULT_SETTINGS,
  formulaVersion: HISTORICAL_FORMULA_VERSION, annualSBCPayrollTaxOverride: 0,
  annualRecurringSBCOverride: 0, compensationMode: 'equity', financingDilution: 0,
  valuationMethod: 'retained-reserve' });

const DAY = 86400000;
const numeric = n => typeof n === 'number' && Number.isFinite(n);
const clamp = (n, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, n));
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const validTimestamp = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && validDate(value.slice(0, 10)) && Number.isFinite(Date.parse(value));
const day = value => typeof value === 'string' && (validDate(value) || validTimestamp(value)) ? value.slice(0, 10) : '';
const millis = value => day(value) ? Date.parse(`${day(value)}T00:00:00Z`) : NaN;
const daysBetween = (a, b) => Number.isFinite(millis(a)) && Number.isFinite(millis(b)) ? (millis(b) - millis(a)) / DAY : Infinity;
const earlierDate = (date, n) => Number.isFinite(millis(date)) ? new Date(millis(date) - n * DAY).toISOString().slice(0, 10) : null;
const finiteOr = (value, fallback) => numeric(value) ? value : fallback;
const mean = values => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
const before = (values, date) => { let found = null; for (const value of values) { if (value.date > date) break; found = value; } return found; };
const growth = (now, old) => numeric(now) && numeric(old) && old > 0 ? now / old - 1 : null;
const historyCache = new Map();
const normalizedInputs = new WeakSet();
function fingerprint(value) {
  const serialized = JSON.stringify(value); let first = 2166136261, second = 537918923;
  for (let index = 0; index < serialized.length; index++) { const code = serialized.charCodeAt(index); first = Math.imul(first ^ code, 16777619); second = Math.imul(second ^ code, 2246822519); }
  return `noncrypto-${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0).toString(16).padStart(8, '0')}-${serialized.length}`;
}
function freezeTree(value, seen = new Set()) {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value); for (const child of Object.values(value)) freezeTree(child, seen); return Object.freeze(value);
}
function cachedHistoryFor(data) {
  const historyFingerprint = fingerprint({ validatorVersion: MODEL_VERSION, formulaVersion: HISTORICAL_FORMULA_VERSION, baseline: HISTORICAL_SETTINGS_V1, prices: data.prices, usdc: data.usdc, rates: data.rates, financials: data.financials, shares: data.shares, dataErrors: data.dataErrors });
  let history = historyCache.get(historyFingerprint);
  if (!history) {
    history = freezeTree(structuredClone(buildHistory(data)));
    if (historyCache.size >= 2) historyCache.delete(historyCache.keys().next().value);
    historyCache.set(historyFingerprint, history);
  }
  return { history, historyFingerprint };
}

function settingsWith(overrides = {}) {
  if (!record(overrides)) overrides = {};
  const result = { ...DEFAULT_SETTINGS, ...overrides, scenarios: {} };
  for (const key of ['bear', 'base', 'bull']) result.scenarios[key] = { ...DEFAULT_SETTINGS.scenarios[key], ...(overrides.scenarios?.[key] || {}) };
  result.maxAllocation = clamp(finiteOr(result.maxAllocation, 0.60));
  result.trancheFraction = clamp(finiteOr(result.trancheFraction, 0.15), 0.01, 1);
  result.initialCash = Math.max(0, finiteOr(result.initialCash, 100000));
  result.cooldownSessions = Math.max(0, Math.round(finiteOr(result.cooldownSessions, 10)));
  result.slippageBps = clamp(finiteOr(result.slippageBps, 10), 0, 9999);
  result.feeBps = clamp(finiteOr(result.feeBps, 5), 0, 10000);
  return result;
}

export function normalizeData(raw = {}) {
  const errors = [];
  const issue = (path, message, knownAt = null) => errors.push({ path, message, knownAt: validDate(knownAt) ? knownAt : null });
  if (!record(raw)) { issue('$', '数据根节点必须是对象'); raw = {}; }
  if (raw.prices !== undefined && !record(raw.prices)) issue('prices', '价格容器必须是对象');
  if (Array.isArray(raw.dataErrors)) for (const error of raw.dataErrors) if (record(error) && typeof error.path === 'string' && typeof error.message === 'string') errors.push(error);
  const list = (value, path) => {
    if (value === undefined) return [];
    if (!Array.isArray(value)) { issue(path, '数据必须是数组，已安全降级为空'); return []; }
    return value;
  };
  const urlValid = value => { try { const url = new URL(value); return typeof value === 'string' && url.protocol === 'https:'; } catch { return false; } };
  const dated = (value, path, requiredDates = ['date']) => {
    if (!record(value)) { issue(path, '观测必须是对象'); return null; }
    const knownAt = validDate(value.availableAt) ? value.availableAt : validDate(value.date) ? value.date : null;
    for (const key of requiredDates) if (!validDate(value[key])) { issue(`${path}.${key}`, '日期必须为真实存在的YYYY-MM-DD，已忽略该观测', knownAt); return null; }
    return { ...value };
  };
  const byDate = rows => rows.sort((a, b) => a.date.localeCompare(b.date));
  const priceRows = ticker => {
    const seen = new Set();
    return byDate(list(raw.prices?.[ticker], `prices.${ticker}`).flatMap((row, index) => {
      const path = `prices.${ticker}[${index}]`, bar = dated(row, path);
      if (!bar) return [];
      if (!numeric(bar.close) || bar.close <= 0) { issue(`${path}.close`, '收盘价必须为有限正数', bar.date); return []; }
      if (seen.has(bar.date)) { issue(`${path}.date`, '重复交易日已忽略', bar.date); return []; }
      seen.add(bar.date);
      for (const key of ['open', 'high', 'low']) if (bar[key] !== undefined && bar[key] !== null && (!numeric(bar[key]) || bar[key] <= 0)) { issue(`${path}.${key}`, '价格必须为有限正数或缺失', bar.date); bar[key] = null; }
      if (numeric(bar.high) && numeric(bar.low) && (bar.high < bar.low || bar.high < bar.close || bar.low > bar.close)) { issue(path, 'OHLC范围不合法，技术价格留空', bar.date); bar.high = null; bar.low = null; }
      return [bar];
    }));
  };
  const observationRows = (key, amountKeys) => byDate(list(raw[key], key).flatMap((row, index) => {
    const path = `${key}[${index}]`, observation = dated(row, path);
    if (!observation) return [];
    if (observation.availableAt !== undefined && !day(observation.availableAt)) { issue(`${path}.availableAt`, '公布时间格式无效', observation.date); return []; }
    for (const amountKey of amountKeys) if (observation[amountKey] !== null && observation[amountKey] !== undefined && (!numeric(observation[amountKey]) || observation[amountKey] < 0)) { issue(`${path}.${amountKey}`, '金额或利率必须为有限非负数', observation.date); observation[amountKey] = null; }
    return [observation];
  }));
  const disclosures = key => list(raw[key], key).flatMap((row, index) => {
    const path = `${key}[${index}]`, disclosure = dated(row, path, key === 'financials' ? ['periodEnd', 'availableAt'] : ['effectiveDate', 'availableAt']);
    if (!disclosure) return [];
    if (key === 'financials' && disclosure.periodEnd > disclosure.availableAt) { issue(path, '财报发布日期不能早于期末', disclosure.availableAt); return []; }
    if (disclosure.effectiveDate !== undefined && !validDate(disclosure.effectiveDate)) { issue(`${path}.effectiveDate`, '生效日期无效', disclosure.availableAt); return []; }
    disclosure.verified = disclosure.verified === true && disclosure.sourceVerified !== false && urlValid(disclosure.sourceUrl);
    if (row.verified === true && !urlValid(row.sourceUrl)) issue(`${path}.sourceUrl`, '已核验披露缺少有效HTTPS原始来源', disclosure.availableAt);
    for (const amountKey of ['dilutedShares', 'annualAdjustedOpex', 'annualRecurringOtherRevenue', 'corporateNetCash', 'futureCapitalCommitments', 'reserveYield', 'reserveRetention', 'otherContributionMargin', 'avgUSDC', 'eopUSDC', 'reserveRevenue', 'distributionCosts', 'distributionAndTransactionCosts', 'totalRevenue', 'rldc', 'adjustedEBITDA', 'quarterAdjustedOpex', 'corporateCash', 'corporateDebt', 'sbcPayrollTaxes', 'stockBasedCompensationExpense']) {
      if (disclosure[amountKey] !== null && disclosure[amountKey] !== undefined && !numeric(disclosure[amountKey])) { issue(`${path}.${amountKey}`, '模型金额、股数和比率必须为有限数值', disclosure.availableAt); disclosure[amountKey] = null; }
    }
    return [disclosure];
  }).sort((a, b) => a.availableAt.localeCompare(b.availableAt));
  const metadata = record(raw.metadata) ? { ...raw.metadata, sources: record(raw.metadata.sources) ? { ...raw.metadata.sources } : {} } : { sources: {} };
  if (raw.metadata !== undefined && !record(raw.metadata)) issue('metadata', '元数据必须是对象');
  if (raw.metadata?.sources !== undefined && !record(raw.metadata.sources)) issue('metadata.sources', '来源状态必须是对象');
  const data = {
    schemaVersion: 1,
    prices: { CRCL: priceRows('CRCL'), SPY: priceRows('SPY') },
    usdc: observationRows('usdc', ['usdc', 'usdcUSD', 'totalStablecoins']), rates: observationRows('rates', ['sofr']),
    financials: disclosures('financials'), shares: disclosures('shares'),
    metadata, assumptions: Array.isArray(raw.assumptions) ? raw.assumptions : [],
    latestOfficialSensitivity: record(raw.latestOfficialSensitivity) ? raw.latestOfficialSensitivity : null
  };
  if (raw.schemaVersion !== undefined && raw.schemaVersion !== 1) issue('schemaVersion', '不支持的数据schema版本');
  data.dataErrors = [...new Map(errors.map(error => [`${error.path}:${error.message}`, error])).values()];
  normalizedInputs.add(data);
  return data;
}

/** Wilder RSI: seed with 14 close-to-close changes, then recursively smooth. */
function rsi(closes, period = 14) {
  if (closes.length <= period) return null;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) { const change = closes[i] - closes[i - 1]; gain += Math.max(0, change); loss += Math.max(0, -change); }
  gain /= period; loss /= period;
  for (let i = period + 1; i < closes.length; i++) { const change = closes[i] - closes[i - 1]; gain = (gain * (period - 1) + Math.max(0, change)) / period; loss = (loss * (period - 1) + Math.max(0, -change)) / period; }
  return gain === 0 && loss === 0 ? 50 : loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
}
function atr(bars, period = 14) {
  if (bars.length < period || bars.some(b => !numeric(b.high) || !numeric(b.low))) return null;
  const tr = bars.map((b, i) => i ? Math.max(b.high - b.low, Math.abs(b.high - bars[i - 1].close), Math.abs(b.low - bars[i - 1].close)) : b.high - b.low);
  let value = mean(tr.slice(0, period));
  for (let i = period; i < tr.length; i++) value = (value * (period - 1) + tr[i]) / period;
  return value;
}
function volatility(closes, period = 20) {
  if (closes.length <= period) return null;
  const window = closes.slice(-period - 1);
  const returns = window.slice(1).map((close, i) => Math.log(close / window[i]));
  const average = mean(returns);
  return Math.sqrt(returns.reduce((sum, n) => sum + (n - average) ** 2, 0) / (period - 1)) * Math.sqrt(252);
}

export function calculateIndicators(bars, usdcHistory = [], spyBars = [], options = {}) {
  if (options?.normalized !== true) {
    bars = Array.isArray(bars) ? bars.filter(bar => record(bar) && validDate(bar.date) && numeric(bar.close) && bar.close > 0) : [];
    usdcHistory = Array.isArray(usdcHistory) ? usdcHistory.filter(row => record(row) && validDate(row.date)) : [];
    spyBars = Array.isArray(spyBars) ? spyBars.filter(bar => record(bar) && validDate(bar.date) && numeric(bar.close) && bar.close > 0) : [];
  }
  if (!bars.length) return {};
  const closes = bars.map(b => b.close), date = bars.at(-1).date, price = closes.at(-1);
  // Undated publication times are conservatively lagged by one calendar day.
  const chain = before(usdcHistory, earlierDate(date, 1));
  const chainOld = n => before(usdcHistory, earlierDate(date, n + 1));
  const share = row => row && numeric(row.totalStablecoins) && row.totalStablecoins > 0 ? (numeric(row.usdcUSD) ? row.usdcUSD : row.usdc) / row.totalStablecoins : null;
  const currentShare = share(chain), oldShare = share(chainOld(90));
  const spy = spyBars.filter(b => b.date <= date), spyNow = spy.at(-1);
  const oldDate = bars.length > 20 ? bars.at(-21).date : null, spyOld = oldDate && before(spy, oldDate);
  return {
    rsi14: rsi(closes), ma20: closes.length >= 20 ? mean(closes.slice(-20)) : null,
    ma60: closes.length >= 60 ? mean(closes.slice(-60)) : null,
    ma120: closes.length >= 120 ? mean(closes.slice(-120)) : null,
    ma200: closes.length >= 200 ? mean(closes.slice(-200)) : null,
    atr14: atr(bars), rv20: volatility(closes), drawdown: price / Math.max(...closes) - 1,
    usdc7d: growth(chain?.usdc, chainOld(7)?.usdc), usdc30d: growth(chain?.usdc, chainOld(30)?.usdc), usdc90d: growth(chain?.usdc, chainOld(90)?.usdc),
    marketShare: currentShare, marketShare90d: numeric(currentShare) && numeric(oldShare) ? currentShare - oldShare : null,
    marketShareValueBasis: numeric(chain?.usdcUSD) ? 'same-source USD market value' : 'legacy nominal USDC with assumed $1 peg',
    benchmarkAsOf: spyNow?.date ?? null, benchmarkWindowStartAsOf: spyOld?.date ?? null,
    relativeReturn20d: oldDate && spyOld?.date === oldDate && spyNow?.date === date ? growth(price, bars.at(-21).close) - growth(spyNow.close, spyOld.close) : null
  };
}

/** Available only from the next CRCL session, regardless of release time. */
function availableSnapshot(rows, date, bars) {
  let selected = null;
  for (const row of rows) {
    if (!row.availableAt) continue;
    const publicationDate = day(row.availableAt);
    const firstSession = bars.find(bar => bar.date > publicationDate)?.date;
    if (!firstSession || firstSession > date) continue;
    if (row.effectiveDate && day(row.effectiveDate) > date) continue;
    selected = row;
  }
  return selected;
}

function fundamentalsAt(data, date) {
  const financial = availableSnapshot(data.financials, date, data.prices.CRCL);
  const shareRow = availableSnapshot(data.shares, date, data.prices.CRCL);
  const chain = before(data.usdc, earlierDate(date, 1));
  const rate = before(data.rates, earlierDate(date, 1));
  if (!financial) return { financialAvailableAt: null, currentUSDC: chain?.usdc ?? null, currentUSDCUSD: chain?.usdcUSD ?? null, currentSOFR: rate?.sofr ?? null, sourcePegProxy: chain?.usdc > 0 && numeric(chain?.usdcUSD) ? chain.usdcUSD / chain.usdc : null, usdcAsOf: chain?.date ?? null, rateAsOf: rate?.date ?? null };
  const distributionCosts = financial.distributionAndTransactionCosts ?? financial.distributionCosts;
  const reserveRetention = finiteOr(financial.reserveRetention, numeric(distributionCosts) && financial.reserveRevenue > 0 ? (financial.reserveRevenue - distributionCosts) / financial.reserveRevenue : null);
  // Calibrate to the realized quarter yield, using only the already-ended quarter.
  // This calibrated spread itself cannot become known before the report release.
  const quarterEnd = financial.periodEnd;
  const start = quarterEnd ? new Date(`${quarterEnd}T00:00:00Z`) : null;
  if (start) { start.setUTCDate(1); start.setUTCMonth(start.getUTCMonth() - 2); }
  const quarterStart = start?.toISOString().slice(0, 10);
  const quarterRates = quarterStart ? data.rates.filter(row => row.date >= quarterStart && row.date <= quarterEnd && numeric(row.sofr)) : [];
  const quarterSOFR = quarterRates.length >= 30 ? mean(quarterRates.map(row => row.sofr)) : null;
  const spread = numeric(financial.reserveYield) && numeric(quarterSOFR) ? financial.reserveYield - quarterSOFR : null;
  const currentReserveYield = numeric(spread) && numeric(rate?.sofr) ? Math.max(0, rate.sofr + spread) : financial.reserveYield ?? null;
  const laggedDate = earlierDate(date, 1), start30 = earlierDate(date, 30), start90 = earlierDate(date, 90);
  const recentUSDC = data.usdc.filter(row => row.date <= laggedDate && row.date >= start30 && numeric(row.usdc));
  const recent90 = data.usdc.filter(row => row.date <= laggedDate && row.date >= start90 && numeric(row.usdc));
  const currentUSDC30d = recentUSDC.length >= 14 ? mean(recentUSDC.map(row => row.usdc)) : null;
  return {
    ...financial, financialAvailableAt: financial.availableAt, financialPeriodEnd: financial.periodEnd,
    currentUSDC: chain?.usdc ?? null, usdcAsOf: chain?.date ?? null, rateAsOf: rate?.date ?? null,
    currentUSDCUSD: chain?.usdcUSD ?? null, sourcePegProxy: chain?.usdc > 0 && numeric(chain?.usdcUSD) ? chain.usdcUSD / chain.usdc : null,
    currentUSDC30d, currentUSDC90d: recent90.length >= 45 ? mean(recent90.map(row => row.usdc)) : null,
    valuationUSDCAnchor: currentUSDC30d ?? chain?.usdc ?? null,
    currentReserveYield, currentSOFR: rate?.sofr ?? null, reserveYieldSpread: spread,
    reserveYieldCalibration: { quarterStart: quarterStart ?? null, quarterEnd: quarterEnd ?? null, averageSOFR: quarterSOFR, calibrated: numeric(spread), reportAvailableAt: financial.availableAt },
    reportedReserveYield: financial.reserveYield ?? null, reserveRetention,
    rldcMargin: finiteOr(financial.rldcMargin, financial.totalRevenue > 0 && numeric(financial.rldc) ? financial.rldc / financial.totalRevenue : null),
    distributionRatio: financial.reserveRevenue > 0 && numeric(distributionCosts) ? distributionCosts / financial.reserveRevenue : null,
    totalCostRatio: financial.totalRevenue > 0 && numeric(financial.distributionCosts) ? financial.distributionCosts / financial.totalRevenue : null,
    annualRecurringOtherRevenue: finiteOr(financial.annualRecurringOtherRevenue, null),
    otherContributionMargin: finiteOr(financial.otherContributionMargin, 0.8),
    dilutedShares: shareRow?.dilutedShares ?? financial.dilutedShares ?? null,
    shareAsOf: shareRow?.effectiveDate || financial.periodEnd,
    sharesProxy: shareRow?.sharesProxy ?? financial.sharesProxy ?? true,
    sharesVerified: shareRow?.verified ?? financial.verified,
    previousFinancial: data.financials.filter(row => row.availableAt && day(row.availableAt) < day(financial.availableAt)).at(-1) || null
  };
}

export function calculateScenario(fundamentals, assumption, settings = {}) {
  const f = record(fundamentals) ? fundamentals : {}, a = record(assumption) ? assumption : {};
  if (!record(settings)) settings = {};
  const yieldAnchor = settings.reserveYieldOverride ?? f.currentReserveYield;
  const retentionAnchor = settings.reserveRetentionOverride ?? f.reserveRetention;
  const annualOpex = settings.annualOpexOverride ?? f.annualAdjustedOpex;
  const shareCount = settings.dilutedSharesOverride ?? f.dilutedShares;
  const recurringOther = settings.annualRecurringOtherRevenueOverride ?? f.annualRecurringOtherRevenue;
  const otherContributionMargin = settings.otherContributionMarginOverride ?? f.otherContributionMargin;
  const corporateNetCash = settings.corporateNetCashOverride ?? f.corporateNetCash;
  const futureCapitalCommitments = settings.futureCapitalCommitmentsOverride ?? f.futureCapitalCommitments;
  const usdcAnchor = f.valuationUSDCAnchor ?? f.currentUSDC;
  const valuationMethod = settings.valuationMethod || 'retained-reserve';
  const compensationMode = settings.compensationMode || 'equity';
  const annualSBCPayrollTax = settings.opexIncludesSBCPayrollTax === true ? 0 : settings.annualSBCPayrollTaxOverride ?? (numeric(f.sbcPayrollTaxes) ? f.sbcPayrollTaxes * 4 : 0);
  const annualRecurringSBC = compensationMode === 'cash' ? settings.annualRecurringSBCOverride ?? (numeric(f.stockBasedCompensationExpense) ? f.stockBasedCompensationExpense * 4 : 0) : 0;
  const financingDilution = settings.financingDilution ?? 0;
  const required = [usdcAnchor, yieldAnchor, retentionAnchor, annualOpex, shareCount, recurringOther, otherContributionMargin, corporateNetCash, futureCapitalCommitments, annualSBCPayrollTax, annualRecurringSBC, financingDilution, ...['usdcGrowth', 'yieldShift', 'retentionShift', 'otherGrowth', 'opexGrowth', 'dilution', 'multiple'].map(key => a[key])];
  const invalid = reason => ({ price: null, forwardEBITDA: null, assumptions: { ...a }, invalid: true, invalidReason: reason, valuationMethod, compensationMode });
  if (compensationMode === 'cash' && settings.annualRecurringSBCOverride == null && !numeric(f.stockBasedCompensationExpense)) return invalid('现金替代SBC缺少已披露季度支出或明确年度假设');
  if (Object.hasOwn(settings, 'annualSBCPayrollTaxOverride') && settings.annualSBCPayrollTaxOverride === null && settings.opexIncludesSBCPayrollTax !== true && !numeric(f.sbcPayrollTaxes)) return invalid('当前公式缺少SBC工资税金额或明确年度假设；不能无证补零');
  if (!required.every(numeric) || usdcAnchor <= 0 || shareCount <= 0 || annualOpex < 0 || recurringOther < 0 || annualSBCPayrollTax < 0 || annualRecurringSBC < 0 || financingDilution < 0 || futureCapitalCommitments < 0 || otherContributionMargin < 0 || otherContributionMargin > 1 || a.multiple < 0 || a.dilution <= -1 || a.usdcGrowth < -1 || a.otherGrowth < -1 || a.opexGrowth < -1 || !['retained-reserve', 'issuer-sensitivity'].includes(valuationMethod) || !['equity', 'cash'].includes(compensationMode)) return invalid('输入不完整或超出经济边界');
  const averageUSDC = usdcAnchor * (1 + a.usdcGrowth / 2);
  const reserveYield = clamp(yieldAnchor + a.yieldShift, 0, 0.15);
  const reserveRetention = clamp(retentionAnchor + a.retentionShift);
  const annualRecurringOtherRevenue = recurringOther * (1 + a.otherGrowth);
  const annualAdjustedOpex = annualOpex * (1 + a.opexGrowth);
  const economicDilution = compensationMode === 'cash' ? 0 : a.dilution;
  const dilutedShares = shareCount * (1 + economicDilution) * (1 + financingDilution);
  const reserveRevenue = averageUSDC * reserveYield;
  let retainedReserveRevenue = reserveRevenue * reserveRetention, netReserveBridge = null;
  if (valuationMethod === 'issuer-sensitivity') {
    const sensitivity = f.sensitivity;
    if (!record(sensitivity) || sensitivity.verified !== true || sensitivity.sourceVerified === false || !validDate(sensitivity.availableAt) || !f.financialAvailableAt || sensitivity.availableAt > f.financialAvailableAt || !numeric(sensitivity.anchorUSDC) || sensitivity.anchorUSDC <= 0 || !numeric(sensitivity.rldcDeltaPer100bps) || !numeric(f.avgUSDC) || f.avgUSDC <= 0 || !numeric(f.reserveYield) || !numeric(f.reserveRevenue) || !numeric(f.distributionAndTransactionCosts) || !validDate(f.periodEnd)) return invalid('当期已披露官方利率敏感度不足，不能套用其他季度或将51%当平均留存率');
    const end = new Date(`${f.periodEnd}T00:00:00Z`), start = new Date(end); start.setUTCDate(1); start.setUTCMonth(start.getUTCMonth() - 2);
    const quarterDays = (end - start) / DAY + 1;
    const referenceAnnualNetReserve = (f.reserveRevenue - f.distributionAndTransactionCosts) * 365 / quarterDays;
    const channelRetentionShift = settings.reserveRetentionOverride !== null && settings.reserveRetentionOverride !== undefined ? retentionAnchor - f.reserveRetention + a.retentionShift : a.retentionShift;
    const scaleTerm = averageUSDC / f.avgUSDC * referenceAnnualNetReserve;
    const rateTerm = averageUSDC / sensitivity.anchorUSDC * sensitivity.rldcDeltaPer100bps * (reserveYield - f.reserveYield) / 0.01;
    const channelTerm = averageUSDC * reserveYield * channelRetentionShift;
    retainedReserveRevenue = scaleTerm + rateTerm + channelTerm;
    netReserveBridge = { referenceAnnualNetReserve, quarterDays, sensitivityAnchorUSDC: sensitivity.anchorUSDC, yieldSensitivity: sensitivity.rldcDeltaPer100bps, scaleTerm, rateTerm, channelTerm, channelRetentionShift, availableAt: sensitivity.availableAt, sourceUrl: sensitivity.sourceUrl || f.sourceUrl };
  }
  const otherContribution = annualRecurringOtherRevenue * otherContributionMargin;
  const forwardEBITDA = retainedReserveRevenue + otherContribution - annualAdjustedOpex - annualSBCPayrollTax - annualRecurringSBC;
  if (![averageUSDC, reserveYield, reserveRetention, reserveRevenue, retainedReserveRevenue, otherContribution, annualAdjustedOpex, dilutedShares, forwardEBITDA].every(numeric)) return invalid('计算结果超出有限数值范围，不能形成估值');
  // An EBITDA multiple is not valid for a loss-making forward scenario.
  const enterpriseValue = forwardEBITDA > 0 ? forwardEBITDA * a.multiple : null;
  const equityValue = enterpriseValue === null ? null : enterpriseValue + corporateNetCash - futureCapitalCommitments;
  if (enterpriseValue !== null && (!numeric(enterpriseValue) || !numeric(equityValue) || !numeric(equityValue / dilutedShares))) return invalid('权益估值超出有限数值范围');
  return { price: equityValue === null ? null : Math.max(0, equityValue / dilutedShares), forwardEBITDA, enterpriseValue, equityValue,
    averageUSDC, reserveYield, reserveRetention, reserveRevenue, retainedReserveRevenue,
    annualRecurringOtherRevenue, otherContribution, otherContributionMargin,
    annualAdjustedOpex, dilutedShares, corporateNetCash, futureCapitalCommitments,
    valuationMethod, compensationMode, annualSBCPayrollTax, annualRecurringSBC, economicDilution, financingDilution, netReserveBridge,
    assumptions: { ...a }, invalid: enterpriseValue === null, invalidReason: enterpriseValue === null ? '已知盈利非正，EV/EBITDA不适用' : null };
}

function scoreParts(f, i, price, scenarios) {
  const baseGap = scenarios.base.price / price - 1, expensive = price / scenarios.base.price - 1;
  const retentionChange = f.previousFinancial && numeric(f.previousFinancial.reserveRetention) ? f.reserveRetention - f.previousFinancial.reserveRetention : 0;
  const rsiValue = finiteOr(i.rsi14, 50), marketShareChange = finiteOr(i.marketShare90d, 0);
  const buy = [
    { label: '基础估值折价', value: 35 * clamp((baseGap + 0.10) / 0.65), max: 35 },
    { label: 'RSI与均线回撤', value: 12 * clamp((60 - rsiValue) / 35) + 8 * clamp(i.ma20 && i.atr14 ? (i.ma20 - price + i.atr14) / (3 * i.atr14) : 0), max: 20 },
    { label: 'USDC增长与份额', value: 12 * clamp((finiteOr(i.usdc30d, 0) + 0.04) / 0.12) + 8 * clamp((marketShareChange + 0.01) / 0.03), max: 20 },
    { label: '趋势与相对强弱', value: (price >= i.ma60 ? 7 : 0) + (i.ma20 >= i.ma60 ? 4 : 0) + 4 * clamp((finiteOr(i.relativeReturn20d, 0) + 0.05) / 0.15), max: 15 },
    { label: '留存水平与波动', value: 5 * clamp((f.reserveRetention - 0.25) / 0.20) + 5 * clamp((1.2 - i.rv20) / 0.8), max: 10 }
  ];
  const sell = [
    { label: '估值溢价', value: 30 * clamp((expensive - 0.10) / 0.50), max: 30 },
    { label: 'RSI过热', value: 20 * clamp((rsiValue - 60) / 25), max: 20 },
    { label: '供给份额与留存恶化', value: 10 * clamp(-finiteOr(i.usdc30d, 0) / 0.08) + 8 * clamp(-marketShareChange / 0.02) + 7 * clamp(-retentionChange / 0.04), max: 25 },
    { label: '趋势退出与相对弱势', value: (price < i.ma60 ? 10 : 0) + (i.ma20 < i.ma60 ? 8 : 0) + 7 * clamp(-finiteOr(i.relativeReturn20d, 0) / 0.15), max: 25 }
  ];
  const precision = value => Math.round(value * 1000000) / 1000000;
  const rounded = parts => parts.map(part => ({ ...part, value: precision(part.value) }));
  return { buyScore: precision(buy.reduce((sum, p) => sum + p.value, 0)), sellScore: precision(sell.reduce((sum, p) => sum + p.value, 0)), buyComponents: rounded(buy), sellComponents: rounded(sell) };
}

function latestSourceIssues(data, asOf) {
  const issues = [];
  for (const key of ['CRCL', 'SPY', 'usdc', 'totalStablecoins', 'rates']) {
    const source = data.metadata?.sources?.[key];
    if (!record(source)) { issues.push(`缺少${key}来源状态`); continue; }
    if (source.status !== 'fresh') issues.push(`${key}来源状态${source.status || '缺失'}，仅fresh允许行动`);
    if (!validDate(source.asOf)) issues.push(`${key}来源asOf日期无效`);
    if (!validTimestamp(source.fetchedAt)) issues.push(`${key}来源fetchedAt时间无效`);
    if (validDate(source.asOf) && validTimestamp(source.fetchedAt) && source.asOf > new Date(source.fetchedAt).toISOString().slice(0, 10)) issues.push(`${key}来源日期晚于实际抓取时间`);
    if (validDate(source.asOf) && (source.asOf > asOf || daysBetween(source.asOf, asOf) > (key === 'rates' ? 10 : ['usdc', 'totalStablecoins'].includes(key) ? 4 : 5))) issues.push(`${key}来源日期超前或超过有效期`);
    if (validTimestamp(source.fetchedAt) && new Date(source.fetchedAt).toISOString().slice(0, 10) > asOf) issues.push(`${key}抓取时间晚于当前评估日`);
    const observedAsOf = ['CRCL', 'SPY'].includes(key) ? data.prices[key]?.at(-1)?.date : key === 'rates' ? data.rates.at(-1)?.date : key === 'usdc' ? data.usdc.at(-1)?.date : data.usdc.filter(row => numeric(row.totalStablecoins) && row.totalStablecoins > 0).at(-1)?.date;
    if (validDate(source.asOf) && source.asOf !== observedAsOf) issues.push(`${key}来源asOf与实际最新观测不一致`);
  }
  return issues;
}

const displayNumber = (value, digits = 1) => numeric(value) ? value.toFixed(digits) : '缺失';
const displayPercent = value => numeric(value) ? `${(value * 100).toFixed(1)}%` : '缺失';
const displayPrice = value => numeric(value) ? `${value.toFixed(2)} USD` : '缺失';
/** The same gates drive both the visible checklist and the machine action. */
export function decisionChecklist(snapshot = {}) {
  if (!record(snapshot)) snapshot = {};
  const i = snapshot.indicators || {}, s = snapshot.decisionSettings || DEFAULT_SETTINGS;
  const basePrice = snapshot.scenarios?.base?.price;
  const dataPass = Array.isArray(snapshot.dataBlockers) && snapshot.dataBlockers.length === 0 && numeric(snapshot.price);
  const riskPass = s.eventRisk !== 'high' && !s.depeg && !snapshot.hardExit;
  const deterioration = (numeric(i.usdc30d) && i.usdc30d < -0.03) || (numeric(i.marketShare90d) && i.marketShare90d < -0.01);
  const trend = numeric(snapshot.price) && numeric(i.ma20) && numeric(i.ma60) && snapshot.price < i.ma60 && i.ma20 < i.ma60;
  const catalyst = (numeric(basePrice) && snapshot.price > basePrice * 1.25) || (numeric(i.rsi14) && i.rsi14 >= 75) || deterioration;
  const confirmation = deterioration || (numeric(snapshot.sellScore) && snapshot.sellScore >= 60);
  const entry = (id, label, observed, target, pass, kind) => ({ id, label, observed, target, pass: Boolean(pass), kind });
  const data = () => entry('data', '完整且有效的资料', dataPass ? snapshot.sourceVerification === 'historical-reconstruction' ? '历史重建资料可计算；源版本未核验' : '完整' : (snapshot.dataBlockers || ['缺失']).join('；'), '无资料否决项', dataPass, 'data');
  return {
    buy: [data(), entry('risk', '事件与盈利风险', riskPass ? '未触发否决' : '风险否决开启', '无脱锚/高风险/盈利破坏', riskPass, 'risk'),
      entry('buy-score', '买入评分', `${displayNumber(snapshot.buyScore)} / 100`, `≥${s.buyThreshold}`, numeric(snapshot.buyScore) && snapshot.buyScore >= s.buyThreshold, 'score'),
      entry('sell-score', '减仓评分制约', `${displayNumber(snapshot.sellScore)} / 100`, '<45', numeric(snapshot.sellScore) && snapshot.sellScore < 45, 'score'),
      entry('supply', '30天USDC供给', displayPercent(i.usdc30d), '≥-3.0%', numeric(i.usdc30d) && i.usdc30d >= -0.03, 'fundamental'),
      entry('discount', '基础估值折价价格', displayPrice(snapshot.price), `≤${displayPrice(numeric(basePrice) ? basePrice * 0.85 : null)}`, numeric(basePrice) && snapshot.price <= basePrice * 0.85, 'price'),
      entry('rsi', 'RSI14不过热', displayNumber(i.rsi14), '≤65', numeric(i.rsi14) && i.rsi14 <= 65, 'trend')],
    reduce: [data(), entry('sell-score', '减仓评分', `${displayNumber(snapshot.sellScore)} / 100`, `≥${s.sellThreshold}`, numeric(snapshot.sellScore) && snapshot.sellScore >= s.sellThreshold, 'score'),
      entry('catalyst', '至少一个减仓触发', `价格${displayPrice(snapshot.price)}；RSI${displayNumber(i.rsi14)}；恶化${deterioration ? '是' : '否'}`, `价格>${displayPrice(numeric(basePrice) ? basePrice * 1.25 : null)} 或RSI≥75 或USDC<-3%/份额<-1pp`, catalyst, 'fundamental')],
    exit: [data(), entry('exit-path', '盈利破坏或双重趋势退出', `盈利破坏${snapshot.hardExit ? '是' : '否'}；MA20/价格<MA60${trend ? '是' : '否'}；恶化或卖分≥60${confirmation ? '是' : '否'}`, '盈利/股权剩余价值≤0，或趋势退出且恶化/卖分≥60', snapshot.hardExit === true || (trend && confirmation), 'risk')]
  };
}

/** Solve one economic variable at a time, holding all other current inputs fixed. */
export function reverseValuation(snapshot = {}, overrides = null) {
  if (!record(snapshot)) snapshot = {};
  const settings = settingsWith(overrides || snapshot.decisionSettings || {});
  const f = snapshot.fundamentals || {}, assumption = settings.scenarios.base;
  const base = calculateScenario(f, assumption, settings), price = snapshot.price;
  const result = { marketPrice: numeric(price) ? price : null, requiredEBITDA: null, requiredAverageUSDC: null, requiredEndUSDCGrowth: null, requiredReserveYield: null, requiredReserveRetention: null, requiredMultiple: null, checks: {}, assumptions: { valuationMethod: base.valuationMethod, compensationMode: base.compensationMode, isolatedVariable: true }, reason: null };
  const missing = !numeric(price) || price <= 0 || !numeric(base.dilutedShares) || !numeric(base.retainedReserveRevenue) || !numeric(base.otherContribution) || !numeric(base.annualAdjustedOpex);
  if (missing) { result.reason = '当前价格或完整模型输入不足，无法倒推'; return result; }
  const requiredEV = price * base.dilutedShares - base.corporateNetCash + base.futureCapitalCommitments;
  const requiredEBITDA = assumption.multiple > 0 ? requiredEV / assumption.multiple : null;
  result.requiredEBITDA = requiredEBITDA;
  result.requiredEnterpriseValue = requiredEV;
  result.assumptions = { ...result.assumptions, shares: base.dilutedShares, corporateNetCash: base.corporateNetCash, futureCapitalCommitments: base.futureCapitalCommitments, multiple: assumption.multiple, currentBasePrice: base.price, modelledAverageUSDC: base.averageUSDC, modelledYield: base.reserveYield, modelledRetention: base.reserveRetention };
  const requiredNetReserve = numeric(requiredEBITDA) ? requiredEBITDA - base.otherContribution + base.annualAdjustedOpex + base.annualSBCPayrollTax + base.annualRecurringSBC : null;
  const anchor = f.valuationUSDCAnchor ?? f.currentUSDC;
  let coefficientA = 0, coefficientB = base.reserveRetention;
  if (base.netReserveBridge) {
    const bridge = base.netReserveBridge;
    coefficientA = bridge.referenceAnnualNetReserve / f.avgUSDC - bridge.yieldSensitivity / bridge.sensitivityAnchorUSDC * f.reserveYield / 0.01;
    coefficientB = bridge.yieldSensitivity / bridge.sensitivityAnchorUSDC / 0.01 + bridge.channelRetentionShift;
  }
  const unitReserve = coefficientA + coefficientB * base.reserveYield;
  const averageUSDC = numeric(requiredNetReserve) && unitReserve > 0 ? requiredNetReserve / unitReserve : null;
  const endUSDCGrowth = numeric(averageUSDC) && anchor > 0 ? 2 * (averageUSDC / anchor - 1) : null;
  const reserveYield = numeric(requiredNetReserve) && base.averageUSDC > 0 && coefficientB !== 0 ? (requiredNetReserve / base.averageUSDC - coefficientA) / coefficientB : null;
  let reserveRetention = numeric(requiredNetReserve) && base.averageUSDC * base.reserveYield > 0 ? requiredNetReserve / (base.averageUSDC * base.reserveYield) : null;
  if (base.netReserveBridge && numeric(reserveRetention)) reserveRetention = f.reserveRetention + (requiredNetReserve - base.netReserveBridge.scaleTerm - base.netReserveBridge.rateTerm) / (base.averageUSDC * base.reserveYield);
  const multiple = base.forwardEBITDA > 0 ? requiredEV / base.forwardEBITDA : null;
  function checked(key, value, inDomain, reproduce, inputOverride = null) {
    const projected = numeric(value) && inDomain ? reproduce(value) : null;
    const reproducedPrice = projected?.price ?? null;
    const achievable = numeric(reproducedPrice) && Math.abs(reproducedPrice - price) <= Math.max(1e-7, price * 1e-8);
    const reason = !numeric(value) ? '输入不足或方程无解' : !inDomain ? '所需变量超出经济边界' : !achievable ? '代回当前模型未能重现市场价；非正盈利倍数可能不适用' : key === 'multiple' && value > 60 ? '数学可解，超一般UI倍数范围；不代表合理' : '单变量代回重现当前市场价，不是预测';
    result.checks[key] = { value: achievable ? value : null, reproducedPrice, achievable, reason, inputOverride: achievable ? inputOverride : null };
    return achievable ? value : null;
  }
  result.requiredAverageUSDC = checked('averageUSDC', averageUSDC, averageUSDC > 0 && endUSDCGrowth >= -1, () => calculateScenario(f, { ...assumption, usdcGrowth: endUSDCGrowth }, settings), endUSDCGrowth);
  result.requiredEndUSDCGrowth = checked('endUSDCGrowth', endUSDCGrowth, endUSDCGrowth >= -1, value => calculateScenario(f, { ...assumption, usdcGrowth: value }, settings), endUSDCGrowth);
  result.requiredReserveYield = checked('reserveYield', reserveYield, reserveYield >= 0 && reserveYield <= 0.15, value => calculateScenario(f, assumption, { ...settings, reserveYieldOverride: value - assumption.yieldShift }), numeric(reserveYield) ? reserveYield - assumption.yieldShift : null);
  result.requiredReserveRetention = checked('reserveRetention', reserveRetention, reserveRetention >= 0 && reserveRetention <= 1, value => calculateScenario(f, assumption, { ...settings, reserveRetentionOverride: value - assumption.retentionShift }), numeric(reserveRetention) ? reserveRetention - assumption.retentionShift : null);
  result.requiredMultiple = checked('multiple', multiple, multiple >= 0, value => calculateScenario(f, { ...assumption, multiple: value }, settings), multiple);
  if (!Object.values(result.checks).some(check => check.achievable)) result.reason = '当前模型没有可实现的单变量解；不补造隐含预期';
  return result;
}

function valuationObservation(snapshot, settings = {}) {
  const f = snapshot?.fundamentals || {}, price = snapshot?.price;
  const shares = settings.dilutedSharesOverride ?? f.dilutedShares;
  const cash = settings.corporateNetCashOverride ?? f.corporateNetCash;
  const end = validDate(f.periodEnd) ? new Date(`${f.periodEnd}T00:00:00Z`) : null;
  const start = end ? new Date(end) : null;
  if (start) { start.setUTCDate(1); start.setUTCMonth(start.getUTCMonth() - 2); }
  const quarterDays = end && start ? (end - start) / DAY + 1 : null;
  const annualize = amount => numeric(amount) && quarterDays > 0 ? amount * 365 / quarterDays : null;
  const annualReportedRevenue = annualize(f.totalRevenue), reportedAnnualEBITDA = annualize(f.adjustedEBITDA), annualRLDC = annualize(f.rldc);
  const marketCap = numeric(price) && numeric(shares) && shares > 0 ? price * shares : null;
  const enterpriseValue = numeric(marketCap) && numeric(cash) ? marketCap - cash : null;
  const ratio = (num, denom) => numeric(num) && numeric(denom) && denom > 0 ? num / denom : null;
  return { ps: ratio(marketCap, annualReportedRevenue), evToReportedAnnualEBITDA: ratio(enterpriseValue, reportedAnnualEBITDA), evToAnnualRLDC: ratio(enterpriseValue, annualRLDC), annualReportedRevenue, reportedAnnualEBITDA, annualRLDC, marketCap, enterpriseValue, period: f.period || f.periodEnd || null, shareAsOf: f.shareAsOf || null, definition: f.accountingDefinition || '原始披露季度数据按实际天数年化的代理；非TTM、非未来12个月', warnings: ['倍数仅作估值观察，不进入买卖评分。', '股本为当时已公开加权稀释代理；净现金沿用保守口径。', '各期保留原披露调整定义，2026定义变化使历史口径并不完全可比。'] };
}
/** Cumulative, point-in-time rank; future observations are never included. */
export function valuationContext(snapshot = {}, previousSnapshots = [], settings = null) {
  if (!record(snapshot)) snapshot = {};
  const observed = valuationObservation(snapshot, settings || snapshot.decisionSettings || {}), percentiles = {};
  const rows = Array.isArray(previousSnapshots) ? previousSnapshots.filter(row => validDate(row?.date) && row.date < snapshot.date) : [];
  for (const key of ['ps', 'evToReportedAnnualEBITDA', 'evToAnnualRLDC']) {
    const values = rows.map(row => row.valuationContext?.[key] ?? valuationObservation(row, HISTORICAL_SETTINGS_V1)[key]).filter(numeric);
    if (numeric(observed[key])) values.push(observed[key]);
    const less = values.filter(value => value < observed[key]).length, equal = values.filter(value => value === observed[key]).length;
    const fraction = values.length && numeric(observed[key]) ? (less + equal / 2) / values.length : null;
    percentiles[key] = { percentile: numeric(fraction) ? fraction * 100 : null, fraction, count: values.length };
  }
  return { ...observed, percentiles, percentilePolicy: '截至该日的累计样本中位秩，percentile单位0–100；不是未来全样本分位' };
}

/** Account limits are configured by the user; no account balance is assumed. */
export function planAllocation(snapshot = {}, inputs = {}) {
  if (!record(snapshot)) snapshot = {};
  const warnings = ['Bear为自定义压力情景，不能当最大风险或本金损失下限。', '额度为单标的预算校验，不自动执行，也不考虑其他持仓相关性。'];
  const result = { configured: false, actionableBuyValue: 0, hypotheticalBuyValue: null, needReduceValue: null, lossRate: null, stressLossBudget: null, stressLossUsed: null, weightHeadroom: null, cashHeadroom: null, stressHeadroom: null, reason: '未配置账户预算', warnings };
  if (!record(inputs)) return result;
  const { portfolioValue, currentHoldingValue, availableCash, maxWeight, maxStressLoss } = inputs;
  if (![portfolioValue, currentHoldingValue, availableCash, maxWeight, maxStressLoss].every(numeric) || portfolioValue <= 0 || currentHoldingValue < 0 || availableCash < 0 || maxWeight < 0 || maxWeight > 1 || maxStressLoss < 0 || (inputs.entryPrice !== undefined && inputs.entryPrice !== null && (!numeric(inputs.entryPrice) || inputs.entryPrice <= 0))) return result;
  if (currentHoldingValue + availableCash > portfolioValue + 1e-8) { result.reason = '持仓与可用现金之和超过组合总资产，请排除重复计算'; return result; }
  result.configured = true;
  result.cashHeadroom = availableCash;
  result.weightHeadroom = Math.max(0, portfolioValue * maxWeight - currentHoldingValue);
  result.stressLossBudget = maxStressLoss;
  const weightReduce = Math.max(0, currentHoldingValue - portfolioValue * maxWeight);
  const bear = snapshot.scenarios?.bear?.price, entryPrice = inputs.entryPrice ?? snapshot.price;
  if (!numeric(bear) || bear < 0 || !numeric(snapshot.price) || snapshot.price <= 0 || !numeric(entryPrice) || entryPrice <= 0) {
    result.needReduceValue = Math.min(currentHoldingValue, weightReduce); result.reason = '账户已配置，但缺少有效Bear压力价，无法计算压力额度'; return result;
  }
  const existingLossRate = clamp(1 - bear / snapshot.price), lossRate = clamp(1 - bear / entryPrice);
  result.lossRate = lossRate; result.existingLossRate = existingLossRate;
  result.stressLossUsed = currentHoldingValue * existingLossRate;
  result.stressHeadroom = Math.max(0, result.stressLossBudget - result.stressLossUsed);
  const stressCashHeadroom = maxStressLoss === 0 ? 0 : lossRate > 0 ? result.stressHeadroom / lossRate : Infinity;
  result.hypotheticalBuyValue = Math.max(0, Math.min(availableCash, result.weightHeadroom, stressCashHeadroom));
  const stressReduce = existingLossRate > 0 ? Math.max(0, result.stressLossUsed - result.stressLossBudget) / existingLossRate : 0;
  result.needReduceValue = Math.min(currentHoldingValue, Math.max(weightReduce, stressReduce));
  const settings = snapshot.decisionSettings || {};
  const blocked = snapshot.hardExit === true || settings.depeg === true || settings.eventRisk === 'high' || !Array.isArray(snapshot.dataBlockers) || snapshot.dataBlockers.length > 0 || snapshot.buyGate !== true;
  result.actionableBuyValue = blocked ? 0 : result.hypotheticalBuyValue;
  result.reason = blocked ? '当前买入或资料/风险门槛未通过，可用额度仅是假设预算' : result.needReduceValue > 0 ? '现有持仓超过至少一个预算，应先复核减仓额度' : '买入门槛通过，额度同时受现金、权重与Bear压力损失预算约束';
  result.inputUnits = { maxWeight: '组合比例0–1', maxStressLoss: 'USD压力损失金额', money: 'USD', entryPrice: 'USD/share' };
  return result;
}

export function evaluateSnapshot(rawData, date, overrides = {}, options = {}) {
  if (!record(options)) options = {};
  const data = options.normalized && record(rawData) && normalizedInputs.has(rawData) ? rawData : normalizeData(rawData), settings = settingsWith(overrides);
  const dataErrors = options.latest ? data.dataErrors || [] : (data.dataErrors || []).filter(error => validDate(error.knownAt) && error.knownAt <= date);
  const bars = data.prices.CRCL.filter(b => b.date <= date), bar = bars.at(-1);
  if (!validDate(date) || !bar) {
    const blockers = [!validDate(date) ? '评估日期无效' : '缺少已收盘股价'];
    const empty = { date: validDate(date) ? date : null, price: null, action: '数据不足', blockers, dataBlockers: blockers, dataErrors, warnings: [], buyScore: null, sellScore: null, scenarios: Object.fromEntries(['bear', 'base', 'bull'].map(key => [key, { price: null, forwardEBITDA: null, invalid: true, invalidReason: '缺少已收盘股价' }])), positionBands: Object.fromEntries(['buyBelow', 'addBelow', 'trimAbove', 'bearReview', 'reduceAbove', 'bear', 'base', 'bull'].map(key => [key, null])), indicators: {}, fundamentals: {}, decisionSettings: settings, sourceVerification: options.latest ? 'latest-source-check' : 'historical-reconstruction', buyGate: false, sellGate: false, exitGate: false, hardExit: false, marker: null, reasons: blockers };
    empty.checklist = decisionChecklist(empty);
    if (options.latest && options.diagnostics !== false) attachDiagnostics(empty, data, settings, options.history);
    return empty;
  }
  const indicators = calculateIndicators(bars, data.usdc, data.prices.SPY, { normalized: true }), fundamentals = fundamentalsAt(data, date);
  const scenarios = Object.fromEntries(['bear', 'base', 'bull'].map(key => [key, calculateScenario(fundamentals, settings.scenarios[key], settings)]));
  const hardExit = (numeric(scenarios.base.forwardEBITDA) && scenarios.base.forwardEBITDA <= 0) || (numeric(scenarios.base.equityValue) && scenarios.base.equityValue <= 0);
  const blockers = [], warnings = [];
  if (!fundamentals.financialAvailableAt) blockers.push('尚无当时已公开并跨过下一交易日的财报');
  else if (fundamentals.verified !== true) blockers.push('财报来源尚未完成独立核验');
  if (fundamentals.financialAvailableAt && fundamentals.sharesVerified !== true) blockers.push('稀释股本代理尚未完成来源核验');
  if (fundamentals.financialAvailableAt && daysBetween(fundamentals.financialAvailableAt, date) > 150) blockers.push('财报快照超过150天');
  if (!numeric(fundamentals.currentUSDC) || !fundamentals.usdcAsOf || daysBetween(fundamentals.usdcAsOf, date) > 4) blockers.push('USDC供给缺失或超过4天');
  if (!numeric(fundamentals.currentReserveYield) || !numeric(fundamentals.currentSOFR) || !fundamentals.rateAsOf || daysBetween(fundamentals.rateAsOf, date) > 10) blockers.push('短端利率缺失或超过10天');
  if (scenarios.base.price === null && !hardExit) blockers.push('关键模型输入缺失或超出经济边界');
  if (bars.length < 60) blockers.push('不足60个收盘交易日');
  if (!numeric(indicators.usdc30d) || !numeric(indicators.marketShare90d) || !numeric(indicators.marketShare)) blockers.push('缺少30天USDC或90天份额观测，无法完整评分');
  if (['rsi14', 'ma20', 'ma60', 'atr14', 'rv20', 'relativeReturn20d'].some(key => !numeric(indicators[key]))) blockers.push('技术或基准指标不足，无法完整评分');
  if (options.latest && options.asOf && daysBetween(date, options.asOf) > 5) blockers.push('最新收盘股价超过5天');
  if (options.latest) {
    blockers.push(...latestSourceIssues(data, validDate(options.asOf) ? options.asOf : date));
    if (data.dataErrors?.length) blockers.push('数据结构存在错误，已安全降级；修复后才允许行动');
    if (!numeric(fundamentals.currentUSDCUSD) || fundamentals.currentUSDCUSD <= 0) blockers.push('生产快照缺少同源USDC美元金额，不能用未核验1美元假定补全市占率');
    if (['open', 'high', 'low'].some(key => !numeric(bar[key]) || bar[key] <= 0) || !numeric(bar.volume) || bar.volume < 0) blockers.push('最新已收盘日线OHLC或成交量字段不完整');
  }
  if (settings.eventRisk === 'high' || settings.depeg) blockers.push(settings.depeg ? '脱锚风险开启，暂停新增' : '人工事件风险否决，暂停新增');
  if (fundamentals.sharesProxy) warnings.push('股本采用已公开稀释股数代理，未等同实际完全稀释股本');
  if (!numeric(fundamentals.currentUSDC30d)) warnings.push('不足14个滞后供给观测，USDC平均锚点退回现货供给');
  if (!numeric(indicators.ma200)) warnings.push('MA200尚未形成，不以短样本替代');
  warnings.push(fundamentals.reserveYieldCalibration?.calibrated ? '储备收益率以已披露季度yield减同季平均SOFR校准spread，再加当前滞后SOFR；仍是代理' : '当季SOFR样本不足，暂用财报季度yield；尚未校准当前储备收益率');
  warnings.push('报告留存率与other贡献率是会计代理，不能代表边际分发协议或真实分部利润率');
  if (settings.valuationMethod === 'issuer-sensitivity') warnings.push('官方100bp敏感度采用局部线性桥接；跨较大利率区间或渠道tier变化时可能失真，不能把51%当平均留存率');
  if (!numeric(fundamentals.currentUSDCUSD)) warnings.push('历史USDC美元金额缺失时按1 USDC=1 USD代理份额，属于旧序列重建假设');
  if (settings.formulaVersion !== HISTORICAL_FORMULA_VERSION) warnings.push('当前1.1公式计入SBC工资税/可选现金替代；历史1.0冻结基线未含工资税，口径不能直接视为同一策略');
  if (hardExit) warnings.push('基础情景盈利或股权剩余价值非正：暂停新增，现有持仓进入退出复核；EV/EBITDA目标价不适用');
  if (numeric(scenarios.bear.price) && numeric(scenarios.base.price) && numeric(scenarios.bull.price) && !(scenarios.bear.price <= scenarios.base.price && scenarios.base.price <= scenarios.bull.price)) warnings.push('自定义情景价格已交叉，Bear/Base/Bull为情景名称，不再代表由低到高价位排序');
  for (const key of ['bear', 'bull']) if (scenarios[key].invalid) warnings.push(`${key === 'bear' ? 'Bear' : 'Bull'}情景${scenarios[key].invalidReason}，该价带留空`);
  if (settings.eventRisk === 'caution') warnings.push('人工事件风险设为警惕；需人工复核，未把事件概率加入历史');
  if (fundamentals.notes) warnings.push(...(Array.isArray(fundamentals.notes) ? fundamentals.notes : [fundamentals.notes]));
  const dataBlockers = blockers.filter(text => !text.includes('暂停新增'));
  let scores = { buyScore: null, sellScore: null, buyComponents: [], sellComponents: [] };
  if (!dataBlockers.length && !hardExit) scores = scoreParts(fundamentals, indicators, bar.close, scenarios);
  const trendExit = bar.close < indicators.ma60 && indicators.ma20 < indicators.ma60;
  const fundamentalDeterioration = indicators.usdc30d < -0.03 || indicators.marketShare90d < -0.01;
  const checklist = decisionChecklist({ price: bar.close, indicators, scenarios, ...scores, dataBlockers, hardExit, decisionSettings: settings, sourceVerification: options.latest ? 'latest-source-check' : 'historical-reconstruction' });
  const passed = rows => rows.every(row => row.pass === true);
  const buyGate = passed(checklist.buy), sellGate = passed(checklist.reduce), exitGate = passed(checklist.exit);
  const action = dataBlockers.length ? '数据不足' : exitGate ? '退出复核' : sellGate ? '候选减仓' : buyGate ? '候选分批' : blockers.length ? '观察（风险否决）' : '观察';
  const reasons = blockers.length ? [...blockers] : hardExit ? ['基础情景盈利或股权剩余价值非正，触发独立退出复核', '估值倍数不适用，买卖总分留空；不得解读为资料缺失'] : [
    numeric(scenarios.base.price) ? `相对基础估值${bar.close <= scenarios.base.price ? '折价' : '溢价'}${(Math.abs(bar.close / scenarios.base.price - 1) * 100).toFixed(1)}%` : '基础情景估值不可用',
    `买入评分${scores.buyScore}/100，减仓评分${scores.sellScore}/100；须同时满足估值与风险门槛`,
    trendExit ? 'MA20低于MA60且价格低于MA60' : '未触发双重趋势退出',
    fundamentalDeterioration ? 'USDC月增或90天份额触发恶化门槛' : '未触发供给/份额恶化门槛'
  ];
  const snapshot = { date: bar.date, price: bar.close, indicators, fundamentals, scenarios, ...scores, action, blockers, warnings,
    buyGate, sellGate, exitGate, hardExit, marker: null, reasons, checklist, decisionSettings: settings, dataBlockers, dataErrors, sourceVerification: options.latest ? 'latest-source-check' : 'historical-reconstruction', formulaVersion: settings.formulaVersion || MODEL_VERSION,
    positionBands: { buyBelow: numeric(scenarios.base.price) ? scenarios.base.price * 0.85 : null, addBelow: numeric(scenarios.base.price) ? scenarios.base.price * 0.70 : null, trimAbove: numeric(scenarios.base.price) ? scenarios.base.price * 1.25 : null, bearReview: scenarios.bear.price, reduceAbove: numeric(scenarios.base.price) ? scenarios.base.price * 1.25 : null, bear: scenarios.bear.price, base: scenarios.base.price, bull: scenarios.bull.price },
    nextTradeDate: data.prices.CRCL.find(b => b.date > date)?.date || null };
  if (options.latest && options.diagnostics !== false) attachDiagnostics(snapshot, data, settings, options.history);
  return snapshot;
}

function attachDiagnostics(snapshot, data, settings, suppliedHistory) {
  const history = Array.isArray(suppliedHistory) ? suppliedHistory : cachedHistoryFor(data).history;
  snapshot.reverseValuation = reverseValuation(snapshot, settings);
  snapshot.valuationContext = valuationContext(snapshot, history, settings);
  snapshot.modelComparison = {
    retainedReserve: calculateScenario(snapshot.fundamentals, settings.scenarios.base, { ...settings, valuationMethod: 'retained-reserve' }),
    issuerSensitivity: calculateScenario(snapshot.fundamentals, settings.scenarios.base, { ...settings, valuationMethod: 'issuer-sensitivity' })
  };
}

/** Immutable baseline: current UI assumptions never rewrite historical markers. */
export function buildHistory(rawData) {
  const data = normalizeData(rawData), rows = []; let lastSignal = -Infinity;
  for (let index = 0; index < data.prices.CRCL.length; index++) {
    const bar = data.prices.CRCL[index];
    const snapshot = evaluateSnapshot(data, bar.date, HISTORICAL_SETTINGS_V1, { normalized: true });
    snapshot.valuationContext = valuationContext(snapshot, rows, HISTORICAL_SETTINGS_V1);
    const urgentExitTransition = snapshot.hardExit && !rows.at(-1)?.hardExit;
    if ((index - lastSignal >= DEFAULT_SETTINGS.cooldownSessions || urgentExitTransition) && ['候选分批', '候选减仓', '退出复核'].includes(snapshot.action)) {
      const type = snapshot.action === '候选分批' ? 'buy' : snapshot.action === '退出复核' ? 'exit' : 'sell';
      snapshot.marker = { type, label: snapshot.action, score: type === 'buy' ? snapshot.buyScore : snapshot.sellScore };
      lastSignal = index;
    }
    rows.push({ ...snapshot, bearPrice: snapshot.scenarios.bear?.price ?? null, basePrice: snapshot.scenarios.base?.price ?? null, bullPrice: snapshot.scenarios.bull?.price ?? null, cooldown: index - lastSignal < DEFAULT_SETTINGS.cooldownSessions });
  }
  return rows;
}

function performance(curve, startCash, valueKey, trades, exposureKey) {
  let peak = startCash, maxDrawdown = 0;
  for (const row of curve) { const value = row[valueKey]; peak = Math.max(peak, value); if (peak > 0) maxDrawdown = Math.min(maxDrawdown, value / peak - 1); }
  const endingEquity = curve.at(-1)?.[valueKey] ?? startCash;
  return { totalReturn: startCash > 0 ? endingEquity / startCash - 1 : null, maxDrawdown, trades, averageExposure: mean(curve.map(row => row[exposureKey])), endingEquity };
}

export function backtest(rawData, history = null, overrides = {}) {
  const data = normalizeData(rawData), settings = settingsWith(overrides), signals = Array.isArray(history) ? history : buildHistory(data);
  const startIndex = signals.findIndex(row => (numeric(row.buyScore) || row.hardExit === true) && !row.blockers?.some(b => !b.includes('暂停新增')));
  const eligibleRows = signals.filter(row => numeric(row?.buyScore) || row?.hardExit === true);
  const windows = new Map();
  for (const row of eligibleRows) {
    const key = row.fundamentals?.financialAvailableAt;
    if (!key) continue;
    const existing = windows.get(key) || { period: row.fundamentals?.period || row.fundamentals?.periodEnd, availableAt: key, firstScoredDate: row.date, scoredDays: 0 };
    existing.lastScoredDate = row.date; existing.scoredDays++; windows.set(key, existing);
  }
  const coverage = { totalDays: signals.length, scoredDays: signals.filter(row => numeric(row?.buyScore)).length, eligibleDays: eligibleRows.length, reportWindows: windows.size, reportWindowDetails: [...windows.values()], buyEpisodes: signals.filter((row, index) => row.buyGate === true && signals[index - 1]?.buyGate !== true).length, actualTrades: 0, closedTradeEvents: 0, winRate: null, active: false, status: 'inactive', historyFormulaVersion: HISTORICAL_FORMULA_VERSION };
  const limitations = ['样本内规则回放，未证明可复制超额收益；规则未经过独立样本外验证。', '历史1.0经济公式冻结重建，当前1.1税费/SBC/第二模型诊断不回填历史；不是实际运营记录。', '链上历史可能修订，公开日与保守一天滞后仅减少前视偏差，无法重建当时供应商完整版本。', '财报发布后的下一交易日才可用；以次日开盘成交，无盘中止损；缺少可靠开盘价则跳过。', '不计税费、融资、现金利息与盘口冲击；费用仅为用户设定的滑点和交易费。', '同配置持有只在初日投入maxAllocation，余款现金；DCA每20个交易日分批，未引入额外入金；市场变化后权重可能漂移。'];
  if (startIndex < 0) return { strategy: null, buyAndHold: null, sameAllocationHold: null, scheduledDCA: null, coverage, equityCurve: [], trades: [], benchmarkTrades: { sameAllocationHold: [], scheduledDCA: [] }, assumptions: settings, limitations: ['没有足够的当时数据，无法回放。', ...limitations], startDate: null };
  let cash = settings.initialCash, position = 0, costBasis = 0, holdCash = settings.initialCash, holdShares = 0, holdBought = false;
  const equalHold = { cash: settings.initialCash, position: 0 }, dca = { cash: settings.initialCash, position: 0 };
  const benchmarkTrades = { sameAllocationHold: [], scheduledDCA: [] };
  const trades = [], curve = [], slip = settings.slippageBps / 10000, feeRate = settings.feeBps / 10000;
  const benchmarkBuy = (portfolio, amount, bar, list) => {
    const fill = bar.open * (1 + slip), spend = Math.max(0, Math.min(portfolio.cash, amount));
    const quantity = spend / (fill * (1 + feeRate)), fee = quantity * fill * feeRate;
    if (quantity <= 1e-9) return false;
    portfolio.cash = Math.max(0, portfolio.cash - quantity * fill - fee); portfolio.position += quantity;
    list.push({ date: bar.date, side: 'buy', quantity, price: fill, fee, cash: portfolio.cash, position: portfolio.position }); return true;
  };
  for (let index = startIndex + 1; index < data.prices.CRCL.length; index++) {
    const bar = data.prices.CRCL[index], signal = signals[index - 1];
    if (numeric(bar.open) && bar.open > 0) {
      if (!holdBought) { const fill = bar.open * (1 + slip); holdShares = holdCash / (fill * (1 + feeRate)); holdCash = 0; holdBought = true; }
      if (!benchmarkTrades.sameAllocationHold.length) benchmarkBuy(equalHold, settings.initialCash * settings.maxAllocation, bar, benchmarkTrades.sameAllocationHold);
      if ((index - startIndex - 1) % 20 === 0) {
        const equity = dca.cash + dca.position * bar.open;
        benchmarkBuy(dca, Math.min(equity * settings.trancheFraction, Math.max(0, equity * settings.maxAllocation - dca.position * bar.open)), bar, benchmarkTrades.scheduledDCA);
      }
      if (signal?.marker?.type === 'buy') {
        const fill = bar.open * (1 + slip), equityAtOpen = cash + position * bar.open;
        const available = Math.min(cash, equityAtOpen * settings.trancheFraction, Math.max(0, equityAtOpen * settings.maxAllocation - position * bar.open));
        const quantity = available / (fill * (1 + feeRate)), fee = quantity * fill * feeRate;
        if (quantity > 1e-9) { cash = Math.max(0, cash - quantity * fill - fee); position += quantity; costBasis += quantity * fill + fee; trades.push({ signalDate: signal.date, date: bar.date, side: 'buy', quantity, price: fill, fee, cash, position }); }
      } else if (position > 0 && ['sell', 'exit'].includes(signal?.marker?.type)) {
        const fill = bar.open * (1 - slip), equityAtOpen = cash + position * bar.open;
        const quantity = signal.marker.type === 'exit' ? position : Math.min(position, equityAtOpen * settings.trancheFraction / bar.open), fee = quantity * fill * feeRate;
        const allocatedCost = position > 0 ? costBasis * quantity / position : 0, realizedPnl = quantity * fill - fee - allocatedCost;
        cash += quantity * fill - fee; position = Math.max(0, position - quantity); costBasis = Math.max(0, costBasis - allocatedCost); trades.push({ signalDate: signal.date, date: bar.date, side: 'sell', quantity, price: fill, fee, cash, position, realizedPnl });
      }
    }
    const strategy = cash + position * bar.close, buyAndHold = holdCash + holdShares * bar.close;
    const sameAllocationHold = equalHold.cash + equalHold.position * bar.close, scheduledDCA = dca.cash + dca.position * bar.close;
    curve.push({ date: bar.date, strategy, buyAndHold, sameAllocationHold, scheduledDCA, exposure: strategy > 0 ? position * bar.close / strategy : 0, holdExposure: buyAndHold > 0 ? holdShares * bar.close / buyAndHold : 0, sameAllocationHoldExposure: sameAllocationHold > 0 ? equalHold.position * bar.close / sameAllocationHold : 0, scheduledDCAExposure: scheduledDCA > 0 ? dca.position * bar.close / scheduledDCA : 0, cash, position, dcaCash: dca.cash, dcaPosition: dca.position });
  }
  const closed = trades.filter(trade => trade.side === 'sell' && numeric(trade.realizedPnl));
  Object.assign(coverage, { actualTrades: trades.length, closedTradeEvents: closed.length, winRate: closed.length ? closed.filter(trade => trade.realizedPnl > 0).length / closed.length : null, active: trades.length > 0, status: trades.length ? 'active' : 'inactive' });
  return { strategy: performance(curve, settings.initialCash, 'strategy', trades.length, 'exposure'), buyAndHold: performance(curve, settings.initialCash, 'buyAndHold', holdBought ? 1 : 0, 'holdExposure'), sameAllocationHold: performance(curve, settings.initialCash, 'sameAllocationHold', benchmarkTrades.sameAllocationHold.length, 'sameAllocationHoldExposure'), scheduledDCA: performance(curve, settings.initialCash, 'scheduledDCA', benchmarkTrades.scheduledDCA.length, 'scheduledDCAExposure'), coverage, benchmarkTrades, equityCurve: curve, trades, startDate: curve[0]?.date || null, endDate: curve.at(-1)?.date || null, assumptions: settings, limitations };
}

export function analyze(rawData, overrides = {}, options = {}) {
  if (!record(options)) options = {};
  const data = normalizeData(rawData), settings = settingsWith(overrides), asOf = day(options.asOf || new Date().toISOString());
  data.prices.CRCL = data.prices.CRCL.filter(bar => bar.date <= asOf);
  data.prices.SPY = data.prices.SPY.filter(bar => bar.date <= asOf);
  const { history, historyFingerprint } = cachedHistoryFor(data);
  const lastDate = data.prices.CRCL.at(-1)?.date || asOf;
  const latest = evaluateSnapshot(data, lastDate, settings, { normalized: true, latest: true, asOf, history });
  const replay = backtest(data, history, settings);
  return { modelVersion: MODEL_VERSION, historyFormulaVersion: HISTORICAL_FORMULA_VERSION, historyFingerprint, dataFingerprint: fingerprint({ historyFingerprint, metadata: data.metadata }), fingerprintPolicy: '非加密本地缓存/重建版本标识；不证明历史源版本或当时已运营', settings, latest, history, backtest: replay, metadata: data.metadata, dataErrors: data.dataErrors, diagnostics: { reverseValuation: latest.reverseValuation, valuationContext: latest.valuationContext, checklist: latest.checklist, modelComparison: latest.modelComparison },
    limitations: ['情景增长、倍数与未来稀释由作者自定，基础情景不是概率加权目标价。', '历史评分及图中历史标记使用冻结基线；当前旋钮仅调整最新估值，无法回填过去。', '历史价带采用各日当时已公开财报、股本代理及滞后供给与利率，旧财报超过150天不行动。', 'USDC供给和SOFR来自第三方/API，不能代表Circle完整储备组合；其他收入须排除ARC等一次性预售。', ...replay.limitations] };
}

export const StableModel = { MODEL_VERSION, HISTORICAL_FORMULA_VERSION, HISTORICAL_SETTINGS_V1, DEFAULT_SETTINGS, normalizeData, analyze, calculateScenario, calculateIndicators, evaluateSnapshot, decisionChecklist, reverseValuation, valuationContext, planAllocation, buildHistory, backtest };
if (typeof globalThis !== 'undefined') globalThis.StableModel = StableModel;
