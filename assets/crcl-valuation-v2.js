/**
 * CRCL V2 research pricing: explicit five-year cash generation, shareholder
 * claim allocation and a separately labelled historical market benchmark.
 * Every monetary input is USD, rates/growth are decimals, shares are counts.
 */
import { normalizeData, evaluateSnapshot } from './crcl-model.js';

export const VALUATION_V2_VERSION = '2.0.0-research';
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
export const V2_DEFAULTS = freeze({
  scenarios: {
    bear: { usdcGrowthStart: 0.12, usdcGrowthEnd: 0.05, rateShift: -0.0035, retentionShiftEnd: -0.005, otherGrowthStart: 0.12, otherGrowthEnd: 0.05, opexGrowth: 0.05, compensationGrowth: 0.05, newGrantDilution: 0.015, requiredReturn: 0.13, terminalGrowth: 0.02, capexGrowth: 0.04 },
    base: { usdcGrowthStart: 0.25, usdcGrowthEnd: 0.12, rateShift: 0, retentionShiftEnd: 0.015, otherGrowthStart: 0.25, otherGrowthEnd: 0.12, opexGrowth: 0.06, compensationGrowth: 0.06, newGrantDilution: 0.01, requiredReturn: 0.12, terminalGrowth: 0.025, capexGrowth: 0.06 },
    bull: { usdcGrowthStart: 0.35, usdcGrowthEnd: 0.20, rateShift: 0.0025, retentionShiftEnd: 0.03, otherGrowthStart: 0.35, otherGrowthEnd: 0.20, opexGrowth: 0.06, compensationGrowth: 0.06, newGrantDilution: 0.01, requiredReturn: 0.11, terminalGrowth: 0.03, capexGrowth: 0.08 },
    severeStress: { usdcGrowthStart: -0.25, usdcGrowthEnd: 0, rateShift: -0.015, retentionShiftEnd: -0.06, otherGrowthStart: 0, otherGrowthEnd: 0, opexGrowth: 0.06, compensationGrowth: 0.06, newGrantDilution: 0.02, requiredReturn: 0.16, terminalGrowth: 0.005, capexGrowth: 0.02 }
  },
  relativeWeight: 0.5, corporateUSDCUsability: 0.8, taxRate: 0.21, nwcRate: 0.03,
  costElasticity: 0.15, opexScaleReferenceGrowth: 0.25, compensationMode: 'equity',
  includePendingDeals: false, opexIncludesSBCPayrollTax: false,
  currentSharesOverride: null, currentUSDCOverride: null, annualOpexOverride: null,
  annualOtherRevenueOverride: null, otherContributionMarginOverride: null,
  annualPayrollTaxOverride: null, annualSBCOverride: null, annualCashCapexOverride: null,
  annualDAOverride: null, corporateNetCashOverride: null, retentionAnchorOverride: null,
  relativeMultipleOverride: null
});

const DAY = 86400000;
const number = value => typeof value === 'number' && Number.isFinite(value);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const time = value => validDate(value) ? Date.parse(`${value}T00:00:00Z`) : NaN;
const dateString = value => new Date(value).toISOString().slice(0, 10);
const lagDate = value => dateString(time(value) - DAY);
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const average = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const lastBefore = (rows, date) => { let selected = null; for (const row of rows || []) if (row.date <= date && (!selected || row.date > selected.date)) selected = row; return selected; };
const known = (row, date) => object(row) && validDate(row.availableAt) && row.availableAt < date && row.verified === true && row.sourceVerified !== false;
const validSourceUrls = urls => Array.isArray(urls) && urls.length > 0 && urls.every(value => { try { return typeof value === 'string' && new URL(value).protocol === 'https:'; } catch { return false; } });
const knownTrading = (row, date, context) => {
  if (!known(row, date)) return false;
  if (!Array.isArray(context?.tradingDates)) return true;
  const next = context.tradingDates.find(day => day > row.availableAt);
  return Boolean(next && next <= date);
};
function settingsWith(overrides = {}) {
  if (!object(overrides)) overrides = {};
  const settings = { ...V2_DEFAULTS, ...overrides, scenarios: {} };
  for (const key of ['bear', 'base', 'bull', 'severeStress']) settings.scenarios[key] = { ...V2_DEFAULTS.scenarios[key], ...(object(overrides.scenarios?.[key]) ? overrides.scenarios[key] : {}) };
  return settings;
}
function addYears(date, count) {
  const origin = new Date(`${date}T00:00:00Z`), year = origin.getUTCFullYear() + count, month = origin.getUTCMonth();
  const end = new Date(Date.UTC(year, month, Math.min(origin.getUTCDate(), new Date(Date.UTC(year, month + 1, 0)).getUTCDate())));
  return end.toISOString().slice(0, 10);
}
function addMonths(date, count) {
  const origin = new Date(`${date}T00:00:00Z`), first = new Date(Date.UTC(origin.getUTCFullYear(), origin.getUTCMonth() + count, 1));
  first.setUTCDate(Math.min(origin.getUTCDate(), new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate()));
  return first.toISOString().slice(0, 10);
}
const linearGrowth = (start, end, year) => start + (end - start) * (year - 1) / 4;

/** Calendar-node interpolation is integrated over each actual anniversary year. */
export function buildReserveRatePath(context, asOf, currentSOFR, reserveSpread) {
  const snapshots = Array.isArray(context?.fedSnapshots) ? context.fedSnapshots : [];
  const snapshot = snapshots.filter(row => knownTrading(row, asOf, context)).sort((a, b) => a.availableAt.localeCompare(b.availableAt)).at(-1);
  if (!snapshot || !validSourceUrls(snapshot.sourceUrls) || !number(currentSOFR) || currentSOFR < 0 || currentSOFR > 0.25 || !number(reserveSpread) || Math.abs(reserveSpread) > 0.05 || !number(snapshot.currentFedMidpoint) || snapshot.currentFedMidpoint < 0 || snapshot.currentFedMidpoint > 0.25 || !object(snapshot.yearEndRates)) return { valid: false, nodes: [], years: [], reason: '缺少当时已公开且来源核验的SEP/利率或小数单位无效' };
  const basis = currentSOFR - snapshot.currentFedMidpoint + reserveSpread;
  const nodes = [{ date: asOf, fedRate: snapshot.currentFedMidpoint, reserveYield: Math.max(0, currentSOFR + reserveSpread), status: 'current_observed_proxy' }];
  for (const [year, rate] of Object.entries(snapshot.yearEndRates)) {
    const date = `${year}-12-31`;
    if (!validDate(date) || !number(rate) || rate < 0 || rate > 0.25) return { valid: false, nodes: [], years: [], reason: 'SEP年末利率节点格式或小数单位无效' };
    if (date > asOf) nodes.push({ date, fedRate: rate, reserveYield: Math.max(0, rate + basis), status: 'official_SEP_year_end_judgment' });
  }
  nodes.sort((a, b) => a.date.localeCompare(b.date));
  const finalOfficial = nodes.at(-1);
  if (!number(snapshot.longRunRate) || snapshot.longRunRate < 0 || snapshot.longRunRate > 0.25 || !Number.isInteger(snapshot.longRunYear) || snapshot.longRunYear <= Number(finalOfficial.date.slice(0, 4))) return { valid: false, nodes: [], years: [], reason: '长期收敛节点无效' };
  const lastOfficialYear = Number(finalOfficial.date.slice(0, 4));
  for (let year = lastOfficialYear + 1; year <= Math.max(snapshot.longRunYear, Number(asOf.slice(0, 4)) + 6); year++) {
    const fraction = clamp((year - lastOfficialYear) / (snapshot.longRunYear - lastOfficialYear), 0, 1);
    const fedRate = finalOfficial.fedRate + (snapshot.longRunRate - finalOfficial.fedRate) * fraction;
    nodes.push({ date: `${year}-12-31`, fedRate, reserveYield: Math.max(0, fedRate + basis), status: 'author_long_run_convergence' });
  }
  const interpolate = date => {
    const target = time(date); let left = nodes[0];
    for (const right of nodes.slice(1)) { if (target <= time(right.date)) return left.reserveYield + (right.reserveYield - left.reserveYield) * (target - time(left.date)) / (time(right.date) - time(left.date)); left = right; }
    return nodes.at(-1).reserveYield;
  };
  const years = [];
  for (let year = 1; year <= 5; year++) {
    const startDate = addYears(asOf, year - 1), endDate = addYears(asOf, year);
    const cuts = [startDate, ...nodes.map(node => node.date).filter(date => date > startDate && date < endDate), endDate];
    let integral = 0;
    for (let i = 1; i < cuts.length; i++) integral += (interpolate(cuts[i - 1]) + interpolate(cuts[i])) / 2 * (time(cuts[i]) - time(cuts[i - 1]));
    years.push({ year, startDate, endDate, reserveYield: integral / (time(endDate) - time(startDate)), startYield: interpolate(startDate), endYield: interpolate(endDate), periodDays: (time(endDate) - time(startDate)) / DAY });
  }
  return { valid: true, nodes, years, sourceAvailableAt: snapshot.availableAt, sourceUrls: snapshot.sourceUrls || [], basisSpread: basis, currentFedMidpoint: snapshot.currentFedMidpoint, longRunFedRate: snapshot.longRunRate, longRunReserveYield: Math.max(0, snapshot.longRunRate + basis), notes: ['SEP为委员年末政策判断，非承诺；年均收益率按实际周年区间积分。', 'SOFR-FF差和报告储备spread在预测期固定，为研究近似。', '2030-31及以后趋向长期节点属于作者假设。'] };
}

function cashAndShares(financial, shareSnapshot, context, asOf, settings) {
  const warnings = [], includedEvents = [], excludedEvents = [];
  const ordinaryCash = financial.corporateCash, debt = financial.corporateDebt;
  const ownedUSDC = financial.corporateHeldStablecoinReserves, arc = financial.arcPresaleCashExcluded;
  let cash = [ordinaryCash, debt, ownedUSDC, arc].every(number) ? ordinaryCash - debt - arc + ownedUSDC * settings.corporateUSDCUsability : null;
  let shares = shareSnapshot?.dilutedShares ?? financial.dilutedShares;
  const eventIds = new Set();
  for (const event of Array.isArray(context.corporateEvents) ? context.corporateEvents : []) {
    if (event.status !== 'completed' || !knownTrading(event, asOf, context) || !validDate(event.effectiveDate) || event.effectiveDate > asOf) continue;
    const id = event.id || `${event.sourceUrl}:${event.effectiveDate}:${event.cashDelta}:${event.sharesDelta}`;
    if (eventIds.has(id)) continue; eventIds.add(id);
    const reflected = event.reflectedInPeriodEnd && validDate(event.reflectedInPeriodEnd) ? event.reflectedInPeriodEnd <= financial.periodEnd : event.effectiveDate <= financial.periodEnd;
    const shareReflected = reflected || (validDate(shareSnapshot?.effectiveDate) && event.effectiveDate <= shareSnapshot.effectiveDate);
    if (!reflected && number(event.cashDelta) && number(cash)) cash += event.cashDelta;
    if (!shareReflected && number(event.sharesDelta) && number(shares)) shares += event.sharesDelta;
    (reflected && shareReflected ? excludedEvents : includedEvents).push({ ...event, cashIncluded: !reflected, sharesIncluded: !shareReflected });
    if (!reflected) warnings.push(`${event.id}:资金按已公开gross proceeds计入，未披露发行费用未补造。`);
  }
  if (settings.corporateNetCashOverride !== null) cash = settings.corporateNetCashOverride;
  if (settings.currentSharesOverride !== null) shares = settings.currentSharesOverride;
  return { corporateNetCash: cash, currentShares: shares, ordinaryCash, corporateDebt: debt, corporateUSDC: ownedUSDC, corporateUSDCUsability: settings.corporateUSDCUsability, arcPresaleCashExcluded: arc, customerReserveCashIncluded: 0, includedEvents, excludedEvents, warnings };
}
function latestFinancial(financials, date) {
  return financials.filter(row => known(row, date)).sort((a, b) => a.availableAt.localeCompare(b.availableAt)).at(-1) || null;
}
function latestShares(shares, date) {
  return shares.filter(row => known(row, date) && validDate(row.effectiveDate) && row.effectiveDate <= date).sort((a, b) => a.availableAt.localeCompare(b.availableAt) || a.effectiveDate.localeCompare(b.effectiveDate)).at(-1) || null;
}
function quantile(values, fraction) {
  const sorted = values.filter(number).sort((a, b) => a - b); if (!sorted.length) return null;
  const position = (sorted.length - 1) * fraction, floor = Math.floor(position), ceil = Math.ceil(position);
  return sorted[floor] + (sorted[ceil] - sorted[floor]) * (position - floor);
}
function quarterKey(date) { return Number(date.slice(0, 4)) * 4 + Math.floor((Number(date.slice(5, 7)) - 1) / 3); }

/** Own historical TTM multiple is market context, not an independent peer valuation. */
export function summarizeRelativeBasis(rawData, context = {}, settingsInput = {}, asOf = new Date().toISOString().slice(0, 10)) {
  const data = normalizeData(rawData), settings = settingsWith(settingsInput), observations = [];
  const recast = context.financialRecasts || rawData?.recasts;
  for (const bar of data.prices.CRCL.filter(row => row.date <= asOf)) {
    const available = data.financials.filter(row => known(row, bar.date));
    const byPeriod = new Map(); for (const row of available) byPeriod.set(row.periodEnd, row);
    const four = [...byPeriod.values()].sort((a, b) => a.periodEnd.localeCompare(b.periodEnd)).slice(-4);
    if (four.length !== 4 || four.some((row, index) => index && quarterKey(row.periodEnd) - quarterKey(four[index - 1].periodEnd) !== 1)) continue;
    const useRecast = object(recast) && validDate(recast.availableAt) && recast.availableAt < bar.date;
    const profits = four.map(row => useRecast && number(recast.adjustedEBITDANewDefinition?.[row.period]) ? recast.adjustedEBITDANewDefinition[row.period] : row.adjustedEBITDA);
    if (!profits.every(number)) continue;
    const ttmAdjustedEBITDA = profits.reduce((sum, value) => sum + value, 0); if (ttmAdjustedEBITDA <= 0) continue;
    const financial = four.at(-1), share = latestShares(data.shares, bar.date);
    const balance = cashAndShares(financial, share, context, bar.date, { ...settings, corporateNetCashOverride: null, currentSharesOverride: null });
    if (!number(balance.currentShares) || balance.currentShares <= 0 || !number(balance.corporateNetCash)) continue;
    const enterpriseValue = bar.close * balance.currentShares - balance.corporateNetCash;
    const multiple = enterpriseValue / ttmAdjustedEBITDA;
    if (!number(multiple) || multiple <= 0) continue;
    observations.push({ date: bar.date, multiple, ttmAdjustedEBITDA, enterpriseValue, currentShares: balance.currentShares, corporateNetCash: balance.corporateNetCash, financialAvailableAt: financial.availableAt, quarters: four.map(row => row.period || row.periodEnd), definition: useRecast ? '当日已公开新定义recasts+原始新口径季度' : '当日已公开原始定义季度；可能与新定义不可完全比' });
  }
  const latest = observations.at(-1), enough = observations.length >= 20 && latest?.quarters.length === 4;
  const multiples = enough ? { bear: quantile(observations.map(row => row.multiple), 0.25), base: quantile(observations.map(row => row.multiple), 0.50), bull: quantile(observations.map(row => row.multiple), 0.75) } : { bear: 24, base: 30, bull: 36 };
  const method = settings.relativeMultipleOverride !== null ? 'user_override' : enough ? 'historical_ttm' : 'author_fallback';
  if (settings.relativeMultipleOverride !== null) for (const key of Object.keys(multiples)) multiples[key] = settings.relativeMultipleOverride;
  return { method, count: observations.length, quarters: latest?.quarters.length || 0, asOf: latest?.date || null, sourceFirstDate: observations[0]?.date || null, multiples, observations, latestTTMAdjustedEBITDA: latest?.ttmAdjustedEBITDA ?? null, currentObservationMultiple: latest?.multiple ?? null, cashPolicy: { corporateUSDCUsability: settings.corporateUSDCUsability, customerReserveCashIncluded: 0 }, warnings: [enough ? '使用自身截至当日历史TTM倍数25/50/75分位，IPO后短样本存在市场情绪和利率混杂。' : '不足20个日期和4个连续已公开季度，24/30/36仅为作者倍数假设。', '无可核实纯发行人上市peer组；自身历史市场定价不是独立内在价值证明。', '每个历史日期仅使用当时已公开财报、股本代理、余额及recasts；并非当时供应商完整历史版本。'] };
}

function pendingShareSchedule(context, asOf, price, settings) {
  if (!settings.includePendingDeals || !number(price) || price <= 0) return [];
  const schedule = [];
  for (const event of Array.isArray(context.corporateEvents) ? context.corporateEvents : []) {
    if (event.status !== 'pending' || !known(event, asOf) || !validDate(event.assumedClosingDate) || event.assumedClosingDate <= asOf) continue;
    if (number(event.stockConsideration) && event.stockConsideration > 0) schedule.push({ id: event.id, date: event.assumedClosingDate, shares: event.stockConsideration / price, type: 'stock_consideration_stress' });
    if (number(event.retentionStock) && event.retentionStock > 0) for (let quarter = 0; quarter < 8; quarter++) schedule.push({ id: event.id, date: addMonths(event.assumedClosingDate, (event.retentionStartMonths ?? 27) + quarter * 3), shares: event.retentionStock / price / 8, type: 'retention_stock_stress' });
  }
  return schedule;
}

function capitalAt(context, asOf) {
  const archive = Array.isArray(context.capitalInputSnapshots) && context.capitalInputSnapshots.length ? context.capitalInputSnapshots : object(context.capitalInputs) ? [context.capitalInputs] : [];
  const selected = archive.filter(row => {
    if (!object(row) || !validDate(row.availableAt) || row.availableAt >= asOf) return false;
    if (!Array.isArray(context.tradingDates)) return true;
    const next = context.tradingDates.find(date => date > row.availableAt);
    return Boolean(next && next <= asOf);
  }).sort((a, b) => a.availableAt.localeCompare(b.availableAt)).at(-1) || null;
  const verified = selected && selected.verified === true && selected.sourceVerified !== false && validSourceUrls(selected.sourceUrls);
  return { selected, verified: Boolean(verified), reason: selected ? verified ? null : '资本再投/D&A源记录未核验或缺有效HTTPS来源，只允许诊断' : '不存在当时已公开的资本再投/D&A快照，不可使用未来披露' };
}

function projectYears(current, financial, capital, ratePath, assumption, settings, pending) {
  const inputs = { annualOpex: settings.annualOpexOverride ?? financial.annualAdjustedOpex,
    annualOtherRevenue: settings.annualOtherRevenueOverride ?? financial.annualRecurringOtherRevenue,
    contributionMargin: settings.otherContributionMarginOverride ?? financial.otherContributionMargin,
    payroll: settings.opexIncludesSBCPayrollTax ? 0 : settings.annualPayrollTaxOverride ?? (number(financial.sbcPayrollTaxes) ? financial.sbcPayrollTaxes * 4 : null),
    cashSBC: settings.compensationMode === 'cash' ? settings.annualSBCOverride ?? (number(financial.stockBasedCompensationExpense) ? financial.stockBasedCompensationExpense * 4 : null) : 0,
    capex: settings.annualCashCapexOverride ?? capital.annualCashCapex,
    da: settings.annualDAOverride ?? capital.annualDA,
    retention: settings.retentionAnchorOverride ?? financial.reserveRetention };
  if (!Object.values(inputs).every(number) || inputs.annualOpex < 0 || inputs.annualOtherRevenue < 0 || inputs.contributionMargin < 0 || inputs.contributionMargin > 1 || inputs.payroll < 0 || inputs.cashSBC < 0 || inputs.capex < 0 || inputs.da < 0 || inputs.retention < 0 || inputs.retention > 1) return { valid: false, years: [], reason: '费用、其他收入、工资税、再投或留存输入缺失/不合法' };
  if (!Object.values(assumption).every(number) || assumption.usdcGrowthStart < -1 || assumption.usdcGrowthEnd < -1 || assumption.otherGrowthStart < -1 || assumption.otherGrowthEnd < -1 || assumption.opexGrowth <= -1 || assumption.compensationGrowth <= -1 || assumption.capexGrowth <= -1 || assumption.newGrantDilution < 0 || assumption.requiredReturn <= 0 || assumption.requiredReturn > 1 || assumption.terminalGrowth <= -1) return { valid: false, years: [], reason: '情景参数超出经济边界' };
  const years = []; let usdc = current.currentUSDC, other = inputs.annualOtherRevenue, opex = inputs.annualOpex, shares = current.currentShares;
  let payroll = inputs.payroll, cashSBC = inputs.cashSBC, capex = inputs.capex, da = inputs.da;
  let priorRLDC = usdc * current.reserveYield * inputs.retention + other * inputs.contributionMargin;
  for (let year = 1; year <= 5; year++) {
    const calendar = ratePath.years[year - 1], growth = linearGrowth(assumption.usdcGrowthStart, assumption.usdcGrowthEnd, year), otherGrowth = linearGrowth(assumption.otherGrowthStart, assumption.otherGrowthEnd, year);
    const startUSDC = usdc, endUSDC = usdc * (1 + growth), averageUSDC = (startUSDC + endUSDC) / 2;
    const reserveYield = clamp(calendar.reserveYield + assumption.rateShift, 0, 0.25), reserveRetention = clamp(inputs.retention + assumption.retentionShiftEnd * year / 5, 0, 1);
    const netReserveIncome = averageUSDC * reserveYield * reserveRetention * calendar.periodDays / 365;
    other *= 1 + otherGrowth;
    const otherContribution = other * inputs.contributionMargin;
    const effectiveOpexGrowth = Math.max(-0.95, assumption.opexGrowth + settings.costElasticity * (growth - settings.opexScaleReferenceGrowth));
    opex *= 1 + effectiveOpexGrowth; payroll *= 1 + assumption.compensationGrowth; cashSBC *= 1 + assumption.compensationGrowth;
    capex *= 1 + assumption.capexGrowth; da *= 1 + assumption.capexGrowth;
    const cashEBITDAProxy = netReserveIncome + otherContribution - opex - payroll - cashSBC;
    const rldcProxy = netReserveIncome + otherContribution, cashTaxes = Math.max(cashEBITDAProxy - da, 0) * settings.taxRate;
    const deltaNWC = (rldcProxy - priorRLDC) * settings.nwcRate;
    const fcff = cashEBITDAProxy - cashTaxes - capex - deltaNWC;
    const netNewGrantDilution = settings.compensationMode === 'cash' ? 0 : assumption.newGrantDilution;
    const pendingEvents = pending.filter(event => event.date > calendar.startDate && event.date <= calendar.endDate);
    const pendingShares = pendingEvents.reduce((sum, event) => sum + event.shares, 0);
    shares = shares * (1 + netNewGrantDilution) + pendingShares;
    const discountFactor = (1 + assumption.requiredReturn) ** year;
    if (![endUSDC, averageUSDC, netReserveIncome, otherContribution, opex, payroll, cashSBC, capex, da, cashTaxes, deltaNWC, cashEBITDAProxy, fcff, shares, discountFactor].every(number) || shares <= 0) return { valid: false, years: [], reason: '现金流或股数计算超出有限范围' };
    years.push({ ...calendar, startYield: clamp(calendar.startYield + assumption.rateShift, 0, 0.25), endYield: clamp(calendar.endYield + assumption.rateShift, 0, 0.25), year, startUSDC, endUSDC, averageUSDC, usdcGrowth: growth, reserveYield, reserveRetention, netReserveIncome, annualRecurringOtherRevenue: other, otherContribution, otherContributionMargin: inputs.contributionMargin, annualAdjustedOpex: opex, effectiveOpexGrowth, annualPayrollTax: payroll, annualCashSBC: cashSBC, cashEBITDAProxy, rldcProxy, cashTaxes, annualDA: da, cashCapex: capex, deltaNWC, fcff, shares, netNewGrantDilution, pendingShares, pendingEvents, cfPerShare: fcff / shares, discountFactor });
    usdc = endUSDC; priorRLDC = rldcProxy;
  }
  return { valid: true, years, inputs };
}

/** Per-share allocation of unlevered business cashflow; net corporate cash added once. */
export function calculateDCF(years, assumption, current, settings = {}, allowRunoff = false) {
  if (!object(assumption) || !object(settings) || !Array.isArray(years) || years.length !== 5 || years.some(row => !object(row) || !number(row.cfPerShare) || !number(row.discountFactor) || row.discountFactor <= 0) || !number(current?.currentShares) || current.currentShares <= 0 || !number(current?.corporateNetCash)) return { price: null, valid: false, reason: '完整五年现金流或当前股本/公司净现金不足' };
  settings = { ...V2_DEFAULTS, ...settings };
  const stableDilution = settings.compensationMode === 'cash' ? 0 : assumption.newGrantDilution;
  const perShareGrowth = (1 + assumption.terminalGrowth) / (1 + stableDilution) - 1;
  if (assumption.requiredReturn <= perShareGrowth) return { price: null, valid: false, reason: '要求回报率必须高于扣稳态稀释后的每股终值增长率' };
  const fifth = years[4], pvCashFlows = years.reduce((sum, row) => sum + row.cfPerShare / row.discountFactor, 0);
  if (!validDate(fifth.endDate)) return { price: null, valid: false, reason: '终态衔接日期缺失' };
  const terminalGrowth = assumption.terminalGrowth;
  const startUSDC = fifth.endUSDC, endUSDC = startUSDC * (1 + terminalGrowth), averageUSDC = (startUSDC + endUSDC) / 2;
  const reserveYield = clamp(current.longRunReserveYield + assumption.rateShift, 0, 0.25);
  const annualRecurringOtherRevenue = fifth.annualRecurringOtherRevenue * (1 + terminalGrowth), otherContribution = annualRecurringOtherRevenue * fifth.otherContributionMargin;
  const annualAdjustedOpex = fifth.annualAdjustedOpex * (1 + terminalGrowth), annualPayrollTax = fifth.annualPayrollTax * (1 + terminalGrowth), annualCashSBC = fifth.annualCashSBC * (1 + terminalGrowth);
  const cashCapex = fifth.cashCapex * (1 + terminalGrowth), annualDA = fifth.annualDA * (1 + terminalGrowth);
  const netReserveIncome = averageUSDC * reserveYield * fifth.reserveRetention, rldcProxy = netReserveIncome + otherContribution;
  const cashEBITDAProxy = rldcProxy - annualAdjustedOpex - annualPayrollTax - annualCashSBC;
  const cashTaxes = Math.max(cashEBITDAProxy - annualDA, 0) * settings.taxRate;
  const deltaNWC = (rldcProxy - fifth.rldcProxy) * settings.nwcRate, fcff = cashEBITDAProxy - cashTaxes - cashCapex - deltaNWC;
  const shares = fifth.shares * (1 + stableDilution), terminalCFPerShare = fcff / shares;
  if (![averageUSDC, reserveYield, netReserveIncome, rldcProxy, cashEBITDAProxy, cashTaxes, cashCapex, annualDA, deltaNWC, fcff, shares, terminalCFPerShare].every(number) || shares <= 0) return { price: null, valid: false, reason: '终态第六年现金流、长期利率或股数输入不足/无效' };
  const startDate = fifth.endDate, endDate = addYears(startDate, 1);
  const terminalYear6 = { year: 6, startDate, endDate, normalizedPeriodDays: 365, calendarDays: (time(endDate) - time(startDate)) / DAY,
    startUSDC, endUSDC, averageUSDC, reserveYield, reserveRetention: fifth.reserveRetention, netReserveIncome, annualRecurringOtherRevenue, otherContribution,
    annualAdjustedOpex, annualPayrollTax, annualCashSBC, cashEBITDAProxy, rldcProxy, annualDA, cashTaxes, cashCapex, deltaNWC, fcff, shares, cfPerShare: terminalCFPerShare,
    role: '期末余额与长期利率重新建模的365日稳态代表年；非把第五年平均余额/收益率永久延长' };
  if (terminalCFPerShare <= 0 && !allowRunoff) return { price: null, valid: false, reason: '末期现金流非正，正常Gordon终值不适用' };
  const terminalValue = terminalCFPerShare > 0 ? terminalCFPerShare / (assumption.requiredReturn - perShareGrowth) : 0;
  const pvTerminal = terminalValue / fifth.discountFactor, netCashPerShare = current.corporateNetCash / current.currentShares;
  const rawPrice = pvCashFlows + pvTerminal + netCashPerShare;
  if (![pvCashFlows, pvTerminal, netCashPerShare, rawPrice].every(number)) return { price: null, valid: false, reason: 'DCF计算超出有限数值范围' };
  const pvBridge = {
    reserve: 0, platform: 0, costs: 0, taxes: 0, capex: 0, nwc: 0, terminal: pvTerminal, netCash: netCashPerShare, limitedLiabilityFloor: Math.max(0, -rawPrice)
  };
  for (const row of years) {
    const divisor = row.shares * row.discountFactor;
    pvBridge.reserve += row.netReserveIncome / divisor; pvBridge.platform += row.otherContribution / divisor;
    pvBridge.costs -= (row.annualAdjustedOpex + row.annualPayrollTax + row.annualCashSBC) / divisor;
    pvBridge.taxes -= row.cashTaxes / divisor; pvBridge.capex -= row.cashCapex / divisor; pvBridge.nwc -= row.deltaNWC / divisor;
  }
  return { valid: true, price: Math.max(0, rawPrice), rawPrice, pvCashFlows, pvTerminal, netCashPerShare,
    terminalShare: pvCashFlows + pvTerminal > 0 ? pvTerminal / (pvCashFlows + pvTerminal) : null,
    terminalShareBasis: '经营现金流DCF的终值占比，排除期初净现金', terminalCFPerShare, cashPerShare6: terminalCFPerShare, terminalYear6, terminalPerShareGrowth: perShareGrowth,
    terminalCompanyGrowth: assumption.terminalGrowth, stableDilution, impliedExitMultiple: fifth.cashEBITDAProxy > 0 ? terminalValue * fifth.shares / fifth.cashEBITDAProxy : null,
    pvBridge, warnings: [terminalCFPerShare <= 0 ? '严重压力末期现金流非正，终值设0仅为停止再经营的runoff研究假设。' : '终态第六年用第五年期末余额、长期yield与稳态费用重算；之后公司现金流按g增长，每股增长再扣稳态稀释。', '终态为365日代表年，避免一次闰年天数被Gordon永久外推；实际第六年日历天数另列。', '逐年FCFF按当年股数分配给当前持有人，再折现；期初净公司现金仅加一次。', '现金EBITDA代理不等已披露Adjusted EBITDA；要求回报是作者资本回报门槛，非确定WACC。'] };
}
function growthExit(years, index, multiple, current) {
  const row = years[index - 1];
  if (!row || !number(multiple) || multiple < 0 || row.cashEBITDAProxy <= 0) return { price: null, diagnostic: true, reason: '期末现金利润非正或市场参照倍数不足' };
  const pvFlows = years.slice(0, index).reduce((sum, year) => sum + year.cfPerShare / year.discountFactor, 0);
  const pvExit = row.cashEBITDAProxy * multiple / row.shares / row.discountFactor;
  return { price: Math.max(0, pvFlows + pvExit + current.corporateNetCash / current.currentShares), horizon: index, exitMultiple: multiple, pvFlows, pvExit, diagnostic: true, role: '延续市场倍数的成长退出侧偏价，仅诊断；不再参与合成' };
}

export function buildValuationV2(rawData, context = {}, settingsInput = {}, options = {}) {
  if (!object(context)) context = {}; if (!object(options)) options = {};
  const settings = settingsWith(settingsInput), today = new Date().toISOString().slice(0, 10);
  const quoteDate = Array.isArray(rawData?.prices?.CRCL) ? rawData.prices.CRCL.at(-1)?.date : null;
  const asOf = options.asOf || (validDate(quoteDate) ? quoteDate : today);
  const dataValidationAsOf = options.dataAsOf || today;
  const empty = reason => ({ version: VALUATION_V2_VERSION, asOf: validDate(asOf) ? asOf : null, current: {}, cases: Object.fromEntries(['bear', 'base', 'bull', 'severeStress'].map(key => [key, { price: null, methods: {}, years: [], warnings: [reason] }])), consensusBand: { low: null, mid: null, high: null }, dataBlockers: [reason], confidence: { level: 'insufficient', reasons: [reason] }, warnings: [reason], settings });
  if (!validDate(asOf)) return empty('评估日期格式无效');
  const fast = object(options.fundamentals) && object(options.relativeBasis);
  const data = fast ? rawData : normalizeData(rawData);
  if (!object(data) || !object(data.prices) || !Array.isArray(data.prices.CRCL)) return empty('股票/财报数据格式无效');
  const bar = lastBefore(data.prices.CRCL, asOf), date = bar?.date;
  if (!date || !number(bar.close)) return empty('缺少当时已收盘股价');
  const valuationContext = { ...context, tradingDates: data.prices.CRCL.map(row => row.date).filter(validDate).sort() };
  const legacy = object(options.fundamentals) ? { fundamentals: options.fundamentals, dataBlockers: [], scenarios: {} } : evaluateSnapshot(data, date, {}, { latest: true, asOf: dataValidationAsOf, diagnostics: false });
  const f = legacy.fundamentals || {}, financial = (data.financials || []).find(row => row.availableAt === f.financialAvailableAt && row.periodEnd === f.financialPeriodEnd) || latestFinancial(data.financials || [], asOf);
  const share = latestShares(data.shares || [], date);
  if (!financial || !f.financialAvailableAt) return empty('没有当时已公开财报，不能补造收入锚');
  if (![settings.relativeWeight, settings.corporateUSDCUsability, settings.taxRate, settings.nwcRate, settings.costElasticity, settings.opexScaleReferenceGrowth].every(number) || settings.relativeWeight < 0 || settings.relativeWeight > 1 || settings.corporateUSDCUsability < 0 || settings.corporateUSDCUsability > 1 || settings.taxRate < 0 || settings.taxRate > 1 || settings.nwcRate < 0 || !['equity', 'cash'].includes(settings.compensationMode)) return empty('全局经济设置超出边界');
  const balance = cashAndShares(financial, share, valuationContext, asOf, settings);
  const chain = lastBefore(data.usdc, lagDate(asOf)), rate = lastBefore(data.rates, lagDate(asOf));
  const current = { price: bar.close, priceAsOf: date, asOf, currentUSDC: settings.currentUSDCOverride ?? chain?.usdc,
    reserveYield: number(rate?.sofr) && number(f.reserveYieldSpread) ? Math.max(0, rate.sofr + f.reserveYieldSpread) : f.currentReserveYield,
    currentSOFR: rate?.sofr ?? f.currentSOFR, reserveSpread: f.reserveYieldSpread,
    usdcAsOf: chain?.date || null, rateAsOf: rate?.date || null, financialPeriod: financial.period, financialAvailableAt: financial.availableAt,
    reserveForecastAnchor: '上一完整日名义USDC供给；未来各年平均=(年初+年末)/2', legacyReserveAnchor: '旧版以滞后30日平均供给作一年预测起点', dataValidationAsOf,
    ...balance, sharesProxy: true };
  if (![current.currentUSDC, current.currentShares, current.corporateNetCash, current.reserveYield, current.currentSOFR, current.reserveSpread].every(number) || current.currentUSDC <= 0 || current.currentShares <= 0) return empty('当前供给、稀释股本、储备spread或公司现金缺失');
  const path = buildReserveRatePath(valuationContext, asOf, current.currentSOFR, current.reserveSpread);
  if (!path.valid) return empty(path.reason);
  current.longRunReserveYield = path.longRunReserveYield;
  const capitalSelection = capitalAt(valuationContext, asOf), capital = capitalSelection.selected || {};
  const contextBlockers = capitalSelection.verified ? [] : [capitalSelection.reason];
  const basisMatches = options.relativeBasis?.cashPolicy?.corporateUSDCUsability === settings.corporateUSDCUsability;
  const relativeBasis = fast && basisMatches ? options.relativeBasis : summarizeRelativeBasis(rawData, context, settings, asOf);
  const pending = pendingShareSchedule(context, asOf, current.price, settings), cases = {};
  for (const key of ['bear', 'base', 'bull', 'severeStress']) {
    const assumption = settings.scenarios[key], projected = projectYears(current, financial, capital, path, assumption, settings, pending);
    if (!projected.valid) { cases[key] = { price: null, methods: {}, years: [], warnings: [projected.reason], assumptions: assumption }; continue; }
    const years = projected.years, first = years[0], dcf = calculateDCF(years, assumption, current, settings, key === 'severeStress');
    const multiple = settings.relativeMultipleOverride ?? relativeBasis.multiples[key === 'severeStress' ? 'bear' : key];
    const relativeEV = first.cashEBITDAProxy > 0 && number(multiple) && multiple >= 0 ? first.cashEBITDAProxy * multiple : null;
    const relativePrice = relativeEV === null ? null : Math.max(0, (relativeEV + current.corporateNetCash) / first.shares);
    const relative = { price: relativePrice, multiple, enterpriseValue: relativeEV, basis: relativeBasis.method, sourceAsOf: relativeBasis.asOf, diagnosticStress: key === 'severeStress', blendEligible: key !== 'severeStress', role: 'NTM现金利润×自身历史TTM市场倍数；市场定价参照，非独立内在价值' };
    let price = null, blendPolicy = 'DCF与相对估值50/50研究中枢；共享收入与费用驱动，不是独立证据投票';
    if (key === 'severeStress') { price = number(dcf.price) ? dcf.price : null; blendPolicy = '独立联合压力仅采用DCF/runoff；Relative保留侧诊断，不混入短期正利润抵抗力'; }
    else if (settings.relativeWeight === 0 && number(dcf.price)) price = dcf.price;
    else if (settings.relativeWeight === 1 && number(relativePrice)) price = relativePrice;
    else if (number(dcf.price) && number(relativePrice)) price = dcf.price * (1 - settings.relativeWeight) + relativePrice * settings.relativeWeight;
    const disagreement = number(dcf.price) && number(relativePrice) && Math.min(dcf.price, relativePrice) > 0 ? Math.max(dcf.price, relativePrice) / Math.min(dcf.price, relativePrice) - 1 : null;
    const warnings = [...dcf.warnings || [], '渠道留存逐步变化、USDC增长、费用弹性和未来净授予稀释均为研究假设，未承诺概率。', '工资税/SBC现金替代按薪酬增长；现金模式不再扣同一未来净授予稀释，已有股本代理不逆向取消。', '其他收入锚为经常性代理，未额外加入Arc、CPN或并购未披露期权/收入。', '年度D&A税盾随再投代理增长，未取得完整资产折旧摊销计划；现金替代仅覆盖P&L SBC，资本化奖励额外现金成本尚未单独建模。'];
    if (pending.length) warnings.push('未交割交易仅做股票稀释压力：按现价作为未来VWAP代理、27个月后RSU分8季归属；不扣同额现金，未知新增经营现金流未估值，不能当完整交易损益结论。');
    if (key === 'severeStress') warnings.push('stressNonGoingConcern为联合存续压力诊断：主价DCF/runoff；不是最低股价或最大亏损保证，短期正利润不证明长期存续。');
    if (number(disagreement) && disagreement > 0.5) warnings.push('DCF与相对估值分歧超过50%，合成中枢置信度降低；市场持续高倍数不是DCF终值的保证。');
    cases[key] = { price: capitalSelection.verified ? price : null, diagnosticPrice: capitalSelection.verified ? null : price, methods: { dcf, relative, growthExit3: growthExit(years, 3, multiple, current), growthExit5: growthExit(years, 5, multiple, current) }, years,
      forwardCashEBITDAProxy: first.cashEBITDAProxy, forwardFCFF: first.fcff, cashEBITDAProxy: first.cashEBITDAProxy, forwardEBITDA: first.cashEBITDAProxy,
      averageUSDC: first.averageUSDC, reserveYield: first.reserveYield, reserveRetention: first.reserveRetention, annualRecurringOtherRevenue: first.annualRecurringOtherRevenue,
      annualAdjustedOpex: first.annualAdjustedOpex, dilutedShares: first.shares, corporateNetCash: current.corporateNetCash, futureCapitalCommitments: 0,
      pvBridge: dcf.pvBridge || null, terminalShare: dcf.terminalShare ?? null, disagreement,
      stressNonGoingConcern: key === 'severeStress' && (years[4].cashEBITDAProxy <= 0 || years[4].fcff <= 0), pricePolicy: key === 'severeStress' ? '独立DCF/runoff压力主价；Relative仅诊断，非底价或最大损失保证' : '两方法按显式权重合成研究中枢',
      assumptions: { ...assumption, methodWeight: key === 'severeStress' ? { dcf: 1, relative: 0 } : { dcf: 1 - settings.relativeWeight, relative: settings.relativeWeight }, companyTerminalGrowth: assumption.terminalGrowth, netNewGrantsDistinctFromExistingWAProxy: true }, blendPolicy, warnings: [...warnings, ...contextBlockers] };
  }
  const normal = ['bear', 'base', 'bull'].map(key => cases[key].price).filter(number);
  const reasons = ['当前稀释股数为已公开WA代理+未被财报反映的已完成事件，不是重建的精确spot fully diluted。', '研究中枢对长期增长/回报门槛及短IPO历史倍数敏感；不能解释为确定目标或概率加权均值。'];
  if (relativeBasis.method !== 'historical_ttm') reasons.push('自身TTM历史不足，倍数为作者/用户假设。');
  if (cases.base.disagreement > 0.5) reasons.push('两方法共享驱动且存在较大分歧，不能当三份独立价值证据。');
  if (legacy.dataBlockers?.length) reasons.push(...legacy.dataBlockers);
  return { version: VALUATION_V2_VERSION, asOf, settings, current, cases, fundamentals: f, reserveRatePath: path, relativeBasis, capitalBasis: { availableAt: capital.availableAt || null, verified: capitalSelection.verified, sourceUrls: capital.sourceUrls || [], versionCount: Array.isArray(context.capitalInputSnapshots) ? context.capitalInputSnapshots.length : capitalSelection.selected ? 1 : 0 },
    consensusBand: { low: normal.length ? Math.min(...normal) : null, mid: cases.base.price, high: normal.length ? Math.max(...normal) : null, policy: '正常研究情景区间，排除severeStress，非置信区间' },
    dataBlockers: [...legacy.dataBlockers || [], ...contextBlockers], confidence: { level: !number(cases.base.price) || legacy.dataBlockers?.length || contextBlockers.length ? 'insufficient' : relativeBasis.method !== 'historical_ttm' || cases.base.disagreement > 0.5 ? 'limited' : 'moderate', reasons: [...reasons, ...contextBlockers] },
    warnings: [...balance.warnings, ...relativeBasis.warnings, '客户储备现金与USDC负债配套，不计公司净现金；公司自持USDC可用性80%为研究折扣。', 'DCF按年度FCFF代理分配到逐年权益后折现；D&A仅用于税盾，不在EBITDA现金流中重复加回。', '3/5年市场倍数退出仅用于比较隐含市场终值，不再次计入合成。'],
    legacyOneYearComparison: { price: legacy.scenarios?.base?.price ?? null, model: '已归档1.1一年利润×22倍旧框架', diagnosis: '旧Base额外-60bp及多假设同时偏保守；不代表中性五年DCF，也不回写历史' } };
}

/** Isolated full-pricing inverse; no direct current-price calibration in defaults. */
export function reverseValuationV2(model, data, context = {}, settingsInput = {}, variable = 'usdcGrowthStart') {
  const currentSettings = object(model?.settings) ? model.settings : {}, overrides = object(settingsInput) ? settingsInput : {};
  const settings = settingsWith({ ...currentSettings, ...overrides, scenarios: Object.fromEntries(['bear', 'base', 'bull', 'severeStress'].map(key => [key, { ...currentSettings.scenarios?.[key], ...overrides.scenarios?.[key] }])) }), target = model?.current?.price, asOf = model?.asOf;
  const domains = { usdcGrowthStart: [-0.90, 1.5], rateShift: [-0.04, 0.08], retentionShiftEnd: [-0.35, 0.50], requiredReturn: [0.04, 0.40], terminalGrowth: [-0.01, 0.08] };
  const result = { variable, value: null, achievable: false, reproducedPrice: null, reason: null, iterations: 0 };
  if (!domains[variable] || !number(target) || !validDate(asOf)) { result.reason = '变量、市场价或评估日期不足'; return result; }
  const evaluate = value => buildValuationV2(data, context, { ...settings, scenarios: { ...settings.scenarios, base: { ...settings.scenarios.base, [variable]: value } } }, { asOf, dataAsOf: model.current?.dataValidationAsOf, fundamentals: model.fundamentals, relativeBasis: model.relativeBasis }).cases.base.price;
  // Bracket using a grid because economic-invalid endpoints must not be made zero.
  const [low, high] = domains[variable], points = [];
  for (let i = 0; i <= 24; i++) { const value = low + (high - low) * i / 24, price = evaluate(value); if (number(price)) points.push({ value, price }); }
  let pair = null;
  for (let i = 1; i < points.length; i++) if ((points[i - 1].price - target) * (points[i].price - target) <= 0) { pair = [points[i - 1], points[i]]; break; }
  if (!pair) { result.reason = '给定经济边界内不能用这一变量单独重现市场价；不补造隐含预期'; return result; }
  for (let iteration = 1; iteration <= 60; iteration++) {
    const value = (pair[0].value + pair[1].value) / 2, price = evaluate(value); result.iterations = iteration;
    if (!number(price)) { result.reason = '倒推进入经济不适用区域'; return result; }
    if (Math.abs(price - target) <= Math.max(1e-6, target * 1e-7)) return { ...result, value, reproducedPrice: price, achievable: true, reason: '其他输入固定，单变量重现当前价；数学要求不等同可实现预测' };
    if ((pair[0].price - target) * (price - target) <= 0) pair[1] = { value, price }; else pair[0] = { value, price };
  }
  result.reason = '迭代未满足代回精度'; return result;
}

export const StableValuationV2 = { VALUATION_V2_VERSION, V2_DEFAULTS, buildReserveRatePath, summarizeRelativeBasis, calculateDCF, buildValuationV2, reverseValuationV2 };
if (typeof globalThis !== 'undefined') globalThis.StableValuationV2 = StableValuationV2;
