/**
 * Independent, deliberately interpretable CRCL scenario model.
 * Dollar amounts are USD, share counts are actual counts, rates are decimals.
 * Signals are conditional research candidates, not predictions or instructions.
 */
export const MODEL_VERSION = '1.0.0-pit';
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
  eventRisk: 'normal', depeg: false,
  buyThreshold: 70, sellThreshold: 65, cooldownSessions: 10,
  initialCash: 100000, maxAllocation: 0.60, trancheFraction: 0.15,
  slippageBps: 10, feeBps: 5
});

const DAY = 86400000;
const numeric = n => typeof n === 'number' && Number.isFinite(n);
const clamp = (n, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, n));
const day = value => String(value || '').slice(0, 10);
const millis = value => Date.parse(`${day(value)}T00:00:00Z`);
const daysBetween = (a, b) => (millis(b) - millis(a)) / DAY;
const earlierDate = (date, n) => new Date(millis(date) - n * DAY).toISOString().slice(0, 10);
const finiteOr = (value, fallback) => numeric(value) ? value : fallback;
const mean = values => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
const sorted = values => [...(values || [])].filter(v => v && v.date).sort((a, b) => a.date.localeCompare(b.date));
const before = (values, date) => { let found = null; for (const value of values) { if (value.date > date) break; found = value; } return found; };
const growth = (now, old) => numeric(now) && numeric(old) && old > 0 ? now / old - 1 : null;

function settingsWith(overrides = {}) {
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
  return {
    schemaVersion: 1,
    prices: { CRCL: sorted(raw.prices?.CRCL).filter(b => numeric(b.close) && b.close > 0), SPY: sorted(raw.prices?.SPY).filter(b => numeric(b.close) && b.close > 0) },
    usdc: sorted(raw.usdc), rates: sorted(raw.rates),
    financials: [...(raw.financials || [])].sort((a, b) => String(a.availableAt).localeCompare(String(b.availableAt))),
    shares: [...(raw.shares || [])].sort((a, b) => String(a.availableAt).localeCompare(String(b.availableAt))),
    metadata: raw.metadata || {}, assumptions: raw.assumptions || []
  };
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

export function calculateIndicators(bars, usdcHistory = [], spyBars = []) {
  if (!bars.length) return {};
  const closes = bars.map(b => b.close), date = bars.at(-1).date, price = closes.at(-1);
  // Undated publication times are conservatively lagged by one calendar day.
  const chain = before(usdcHistory, earlierDate(date, 1));
  const chainOld = n => before(usdcHistory, earlierDate(date, n + 1));
  const share = row => row && numeric(row.totalStablecoins) && row.totalStablecoins > 0 ? row.usdc / row.totalStablecoins : null;
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
    benchmarkAsOf: spyNow?.date ?? null, benchmarkWindowStartAsOf: spyOld?.date ?? null,
    relativeReturn20d: oldDate && spyOld?.date === oldDate && spyNow?.date === date ? growth(price, bars.at(-21).close) - growth(spyNow.close, spyOld.close) : null
  };
}

/** Available only from the next CRCL session, regardless of release time. */
function availableSnapshot(rows, date, bars) {
  let selected = null;
  for (const row of rows) {
    if (!row.availableAt) continue;
    const firstSession = bars.find(bar => bar.date > day(row.availableAt))?.date;
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
  if (!financial) return { financialAvailableAt: null, currentUSDC: chain?.usdc ?? null, usdcAsOf: chain?.date ?? null, rateAsOf: rate?.date ?? null };
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
  const recentUSDC = data.usdc.filter(row => row.date <= earlierDate(date, 1) && row.date >= earlierDate(date, 30) && numeric(row.usdc));
  const recent90 = data.usdc.filter(row => row.date <= earlierDate(date, 1) && row.date >= earlierDate(date, 90) && numeric(row.usdc));
  const currentUSDC30d = recentUSDC.length >= 14 ? mean(recentUSDC.map(row => row.usdc)) : null;
  return {
    ...financial, financialAvailableAt: financial.availableAt, financialPeriodEnd: financial.periodEnd,
    currentUSDC: chain?.usdc ?? null, usdcAsOf: chain?.date ?? null, rateAsOf: rate?.date ?? null,
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
  const f = fundamentals, a = assumption;
  const yieldAnchor = settings.reserveYieldOverride ?? f.currentReserveYield;
  const retentionAnchor = settings.reserveRetentionOverride ?? f.reserveRetention;
  const annualOpex = settings.annualOpexOverride ?? f.annualAdjustedOpex;
  const shareCount = settings.dilutedSharesOverride ?? f.dilutedShares;
  const recurringOther = settings.annualRecurringOtherRevenueOverride ?? f.annualRecurringOtherRevenue;
  const otherContributionMargin = settings.otherContributionMarginOverride ?? f.otherContributionMargin;
  const corporateNetCash = settings.corporateNetCashOverride ?? f.corporateNetCash;
  const futureCapitalCommitments = settings.futureCapitalCommitmentsOverride ?? f.futureCapitalCommitments;
  const usdcAnchor = f.valuationUSDCAnchor ?? f.currentUSDC;
  const required = [usdcAnchor, yieldAnchor, retentionAnchor, annualOpex, shareCount, recurringOther, otherContributionMargin, corporateNetCash, futureCapitalCommitments, ...Object.values(a)];
  if (!required.every(numeric) || shareCount <= 0 || annualOpex < 0 || recurringOther < 0 || futureCapitalCommitments < 0 || otherContributionMargin < 0 || otherContributionMargin > 1 || a.multiple < 0 || a.dilution <= -1 || a.usdcGrowth < -1 || a.otherGrowth < -1 || a.opexGrowth < -1) return { price: null, forwardEBITDA: null, assumptions: { ...a }, invalid: true, invalidReason: '输入不完整或超出经济边界' };
  const averageUSDC = usdcAnchor * (1 + a.usdcGrowth / 2);
  const reserveYield = clamp(yieldAnchor + a.yieldShift, 0, 0.15);
  const reserveRetention = clamp(retentionAnchor + a.retentionShift);
  const annualRecurringOtherRevenue = recurringOther * (1 + a.otherGrowth);
  const annualAdjustedOpex = annualOpex * (1 + a.opexGrowth);
  const dilutedShares = shareCount * (1 + a.dilution);
  const reserveRevenue = averageUSDC * reserveYield;
  const retainedReserveRevenue = reserveRevenue * reserveRetention;
  const otherContribution = annualRecurringOtherRevenue * otherContributionMargin;
  const forwardEBITDA = retainedReserveRevenue + otherContribution - annualAdjustedOpex;
  // An EBITDA multiple is not valid for a loss-making forward scenario.
  const enterpriseValue = forwardEBITDA > 0 ? forwardEBITDA * a.multiple : null;
  const equityValue = enterpriseValue === null ? null : enterpriseValue + corporateNetCash - futureCapitalCommitments;
  return { price: equityValue === null ? null : Math.max(0, equityValue / dilutedShares), forwardEBITDA, enterpriseValue, equityValue,
    averageUSDC, reserveYield, reserveRetention, reserveRevenue, retainedReserveRevenue,
    annualRecurringOtherRevenue, otherContribution, otherContributionMargin,
    annualAdjustedOpex, dilutedShares, corporateNetCash, futureCapitalCommitments,
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

export function evaluateSnapshot(rawData, date, overrides = {}, options = {}) {
  const data = options.normalized ? rawData : normalizeData(rawData), settings = settingsWith(overrides);
  const bars = data.prices.CRCL.filter(b => b.date <= date), bar = bars.at(-1);
  if (!bar) return { date, price: null, action: '数据不足', blockers: ['缺少已收盘股价'], warnings: [], buyScore: null, sellScore: null, scenarios: {}, indicators: {}, fundamentals: {} };
  const indicators = calculateIndicators(bars, data.usdc, data.prices.SPY), fundamentals = fundamentalsAt(data, date);
  const scenarios = Object.fromEntries(['bear', 'base', 'bull'].map(key => [key, calculateScenario(fundamentals, settings.scenarios[key], settings)]));
  const hardExit = (numeric(scenarios.base.forwardEBITDA) && scenarios.base.forwardEBITDA <= 0) || (numeric(scenarios.base.equityValue) && scenarios.base.equityValue <= 0);
  const blockers = [], warnings = [];
  if (!fundamentals.financialAvailableAt) blockers.push('尚无当时已公开并跨过下一交易日的财报');
  else if (fundamentals.verified !== true) blockers.push('财报来源尚未完成独立核验');
  if (fundamentals.financialAvailableAt && fundamentals.sharesVerified !== true) blockers.push('稀释股本代理尚未完成来源核验');
  if (fundamentals.financialAvailableAt && daysBetween(fundamentals.financialAvailableAt, date) > 150) blockers.push('财报快照超过150天');
  if (!numeric(fundamentals.currentUSDC) || !fundamentals.usdcAsOf || daysBetween(fundamentals.usdcAsOf, date) > 4) blockers.push('USDC供给缺失或超过4天');
  if (!numeric(fundamentals.currentReserveYield) || !fundamentals.rateAsOf || daysBetween(fundamentals.rateAsOf, date) > 10) blockers.push('短端利率缺失或超过10天');
  if (scenarios.base.price === null && !hardExit) blockers.push('关键模型输入缺失或超出经济边界');
  if (bars.length < 60) blockers.push('不足60个收盘交易日');
  if (!numeric(indicators.usdc30d) || !numeric(indicators.marketShare90d) || !numeric(indicators.marketShare)) blockers.push('缺少30天USDC或90天份额观测，无法完整评分');
  if (['rsi14', 'ma20', 'ma60', 'atr14', 'rv20', 'relativeReturn20d'].some(key => !numeric(indicators[key]))) blockers.push('技术或基准指标不足，无法完整评分');
  if (options.latest && options.asOf && daysBetween(date, options.asOf) > 5) blockers.push('最新收盘股价超过5天');
  if (options.latest && Object.entries(data.metadata.sources || {}).some(([key, source]) => ['CRCL', 'SPY', 'usdc', 'totalStablecoins', 'rates'].includes(key) && ['cached', 'failed'].includes(source.status))) blockers.push('关键数据更新失败，旧缓存仅供观察');
  if (settings.eventRisk === 'high' || settings.depeg) blockers.push(settings.depeg ? '脱锚风险开启，暂停新增' : '人工事件风险否决，暂停新增');
  if (fundamentals.sharesProxy) warnings.push('股本采用已公开稀释股数代理，未等同实际完全稀释股本');
  if (!numeric(fundamentals.currentUSDC30d)) warnings.push('不足14个滞后供给观测，USDC平均锚点退回现货供给');
  if (!numeric(indicators.ma200)) warnings.push('MA200尚未形成，不以短样本替代');
  warnings.push(fundamentals.reserveYieldCalibration?.calibrated ? '储备收益率以已披露季度yield减同季平均SOFR校准spread，再加当前滞后SOFR；仍是代理' : '当季SOFR样本不足，暂用财报季度yield；尚未校准当前储备收益率');
  warnings.push('报告留存率与other贡献率是会计代理，不能代表边际分发协议或真实分部利润率');
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
  const buyGate = !blockers.length && scores.buyScore >= settings.buyThreshold && scores.sellScore < 45 && indicators.usdc30d >= -0.03 && bar.close <= scenarios.base.price * 0.85 && indicators.rsi14 <= 65;
  const sellGate = !dataBlockers.length && scores.sellScore >= settings.sellThreshold && (bar.close > scenarios.base.price * 1.25 || indicators.rsi14 >= 75 || fundamentalDeterioration);
  const exitGate = !dataBlockers.length && (hardExit || (trendExit && (fundamentalDeterioration || scores.sellScore >= 60)));
  const action = dataBlockers.length ? '数据不足' : exitGate ? '退出复核' : sellGate ? '候选减仓' : buyGate ? '候选分批' : blockers.length ? '观察（风险否决）' : '观察';
  const reasons = blockers.length ? [...blockers] : hardExit ? ['基础情景盈利或股权剩余价值非正，触发独立退出复核', '估值倍数不适用，买卖总分留空；不得解读为资料缺失'] : [
    numeric(scenarios.base.price) ? `相对基础估值${bar.close <= scenarios.base.price ? '折价' : '溢价'}${(Math.abs(bar.close / scenarios.base.price - 1) * 100).toFixed(1)}%` : '基础情景估值不可用',
    `买入评分${scores.buyScore}/100，减仓评分${scores.sellScore}/100；须同时满足估值与风险门槛`,
    trendExit ? 'MA20低于MA60且价格低于MA60' : '未触发双重趋势退出',
    fundamentalDeterioration ? 'USDC月增或90天份额触发恶化门槛' : '未触发供给/份额恶化门槛'
  ];
  return { date: bar.date, price: bar.close, indicators, fundamentals, scenarios, ...scores, action, blockers, warnings,
    buyGate, sellGate, exitGate, hardExit, marker: null, reasons,
    positionBands: { buyBelow: numeric(scenarios.base.price) ? scenarios.base.price * 0.85 : null, addBelow: numeric(scenarios.base.price) ? scenarios.base.price * 0.70 : null, trimAbove: numeric(scenarios.base.price) ? scenarios.base.price * 1.25 : null, bearReview: scenarios.bear.price, reduceAbove: numeric(scenarios.base.price) ? scenarios.base.price * 1.25 : null, bear: scenarios.bear.price, base: scenarios.base.price, bull: scenarios.bull.price },
    nextTradeDate: data.prices.CRCL.find(b => b.date > date)?.date || null };
}

/** Immutable baseline: current UI assumptions never rewrite historical markers. */
export function buildHistory(rawData) {
  const data = normalizeData(rawData), rows = []; let lastSignal = -Infinity;
  for (let index = 0; index < data.prices.CRCL.length; index++) {
    const bar = data.prices.CRCL[index];
    const snapshot = evaluateSnapshot(data, bar.date, DEFAULT_SETTINGS, { normalized: true });
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
  const data = normalizeData(rawData), settings = settingsWith(overrides), signals = history || buildHistory(data);
  const startIndex = signals.findIndex(row => (numeric(row.buyScore) || row.hardExit === true) && !row.blockers?.some(b => !b.includes('暂停新增')));
  const limitations = ['样本内规则回放，未证明可复制超额收益；规则未经过独立样本外验证。', '链上历史可能修订，公开日与保守一天滞后仅减少前视偏差，无法重建当时供应商完整版本。', '财报发布后的下一交易日才可用；以次日开盘成交，无盘中止损；缺少可靠开盘价则跳过。', '不计税费、融资、现金利息与盘口冲击；费用仅为用户设定的滑点和交易费。'];
  if (startIndex < 0) return { strategy: null, buyAndHold: null, equityCurve: [], trades: [], assumptions: settings, limitations: ['没有足够的当时数据，无法回放。', ...limitations], startDate: null };
  let cash = settings.initialCash, position = 0, holdCash = settings.initialCash, holdShares = 0, holdBought = false;
  const trades = [], curve = [], slip = settings.slippageBps / 10000, feeRate = settings.feeBps / 10000;
  for (let index = startIndex + 1; index < data.prices.CRCL.length; index++) {
    const bar = data.prices.CRCL[index], signal = signals[index - 1];
    if (numeric(bar.open) && bar.open > 0) {
      if (!holdBought) { const fill = bar.open * (1 + slip); holdShares = holdCash / (fill * (1 + feeRate)); holdCash = 0; holdBought = true; }
      if (signal?.marker?.type === 'buy') {
        const fill = bar.open * (1 + slip), equityAtOpen = cash + position * bar.open;
        const available = Math.min(cash, equityAtOpen * settings.trancheFraction, Math.max(0, equityAtOpen * settings.maxAllocation - position * bar.open));
        const quantity = available / (fill * (1 + feeRate)), fee = quantity * fill * feeRate;
        if (quantity > 1e-9) { cash = Math.max(0, cash - quantity * fill - fee); position += quantity; trades.push({ signalDate: signal.date, date: bar.date, side: 'buy', quantity, price: fill, fee, cash, position }); }
      } else if (position > 0 && ['sell', 'exit'].includes(signal?.marker?.type)) {
        const fill = bar.open * (1 - slip), equityAtOpen = cash + position * bar.open;
        const quantity = signal.marker.type === 'exit' ? position : Math.min(position, equityAtOpen * settings.trancheFraction / bar.open), fee = quantity * fill * feeRate;
        cash += quantity * fill - fee; position = Math.max(0, position - quantity); trades.push({ signalDate: signal.date, date: bar.date, side: 'sell', quantity, price: fill, fee, cash, position });
      }
    }
    const strategy = cash + position * bar.close, buyAndHold = holdCash + holdShares * bar.close;
    curve.push({ date: bar.date, strategy, buyAndHold, exposure: strategy > 0 ? position * bar.close / strategy : 0, holdExposure: buyAndHold > 0 ? holdShares * bar.close / buyAndHold : 0, cash, position });
  }
  return { strategy: performance(curve, settings.initialCash, 'strategy', trades.length, 'exposure'), buyAndHold: performance(curve, settings.initialCash, 'buyAndHold', holdBought ? 1 : 0, 'holdExposure'), equityCurve: curve, trades, startDate: curve[0]?.date || null, endDate: curve.at(-1)?.date || null, assumptions: settings, limitations };
}

export function analyze(rawData, overrides = {}, options = {}) {
  const data = normalizeData(rawData), settings = settingsWith(overrides), asOf = day(options.asOf || new Date().toISOString());
  data.prices.CRCL = data.prices.CRCL.filter(bar => bar.date <= asOf);
  data.prices.SPY = data.prices.SPY.filter(bar => bar.date <= asOf);
  const history = buildHistory(data);
  const lastDate = data.prices.CRCL.at(-1)?.date || asOf;
  const latest = evaluateSnapshot(data, lastDate, settings, { normalized: true, latest: true, asOf });
  const replay = backtest(data, history, settings);
  return { modelVersion: MODEL_VERSION, settings, latest, history, backtest: replay, metadata: data.metadata,
    limitations: ['情景增长、倍数与未来稀释由作者自定，基础情景不是概率加权目标价。', '历史评分及图中历史标记使用冻结基线；当前旋钮仅调整最新估值，无法回填过去。', '历史价带采用各日当时已公开财报、股本代理及滞后供给与利率，旧财报超过150天不行动。', 'USDC供给和SOFR来自第三方/API，不能代表Circle完整储备组合；其他收入须排除ARC等一次性预售。', ...replay.limitations] };
}

export const StableModel = { MODEL_VERSION, DEFAULT_SETTINGS, normalizeData, analyze, calculateScenario, calculateIndicators, evaluateSnapshot, buildHistory, backtest };
if (typeof globalThis !== 'undefined') globalThis.StableModel = StableModel;
