import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, HISTORICAL_SETTINGS_V1, normalizeData, analyze, buildHistory, calculateScenario, calculateIndicators, evaluateSnapshot, decisionChecklist, reverseValuation, valuationContext, planAllocation, backtest } from '../assets/crcl-model.js';

const dateAt = index => new Date(Date.UTC(2025, 0, 1 + index)).toISOString().slice(0, 10);
function fixture(count = 140) {
  const prices = [];
  for (let dayIndex = 0; prices.length < count; dayIndex++) {
    const date = dateAt(dayIndex), weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
    if (!weekday || weekday === 6) continue;
    const close = 10 + Math.sin(prices.length / 3) * 0.5;
    prices.push({ date, open: close + 0.1, high: close + 0.3, low: close - 0.3, close, volume: 10000 });
  }
  const usdc = [], rates = [];
  for (let i = -150; dateAt(i) <= prices.at(-1).date; i++) {
    usdc.push({ date: dateAt(i), usdc: 80000000000 * (1 + i * 0.0005), usdcUSD: 80000000000 * (1 + i * 0.0005), totalStablecoins: 200000000000 });
    rates.push({ date: dateAt(i), sofr: 0.04 });
  }
  const financial = { periodEnd: '2024-12-31', availableAt: '2025-02-03', avgUSDC: 80000000000, reserveYield: 0.04, reserveRevenue: 800000000, distributionCosts: 480000000, reserveRetention: 0.4,
    annualRecurringOtherRevenue: 100000000, otherContributionMargin: 0.8, annualAdjustedOpex: 500000000, corporateNetCash: 1000000000, futureCapitalCommitments: 100000000,
    dilutedShares: 300000000, verified: true, sourceUrl: 'https://example.test/financial/2024Q4', sharesProxy: true, totalRevenue: 850000000, adjustedEBITDA: 200000000, rldc: 370000000, sbcPayrollTaxes: 0, stockBasedCompensationExpense: 40000000 };
  const asOf = prices.at(-1).date, fetchedAt = `${asOf}T22:00:00Z`;
  const sources = Object.fromEntries(['CRCL', 'SPY', 'usdc', 'totalStablecoins', 'rates'].map(key => [key, { status: 'fresh', asOf, fetchedAt, url: `https://example.test/${key}` }]));
  return { prices: { CRCL: prices, SPY: prices.map(b => ({ ...b, open: 100, high: 101, low: 99, close: 100 })) }, usdc, rates,
    financials: [financial], shares: [{ effectiveDate: '2024-12-31', availableAt: '2025-02-03', dilutedShares: 300000000, verified: true, sourceUrl: 'https://example.test/financial/2024Q4' }], metadata: { generatedAt: fetchedAt, sources } };
}
const f = { currentUSDC: 80000000000, currentReserveYield: 0.04, reserveRetention: 0.4, annualAdjustedOpex: 500000000, dilutedShares: 300000000,
  annualRecurringOtherRevenue: 100000000, otherContributionMargin: 0.8, corporateNetCash: 1000000000, futureCapitalCommitments: 100000000, sbcPayrollTaxes: 0, stockBasedCompensationExpense: 40000000 };
const zero = { usdcGrowth: 0, yieldShift: 0, retentionShift: 0, otherGrowth: 0, opexGrowth: 0, dilution: 0, multiple: 20 };

test('Economic identity retains every cash-flow layer and excludes customer reserves', () => {
  const value = calculateScenario({ ...f, customerReserveCash: 90000000000 }, zero);
  assert.equal(value.forwardEBITDA, 80000000000 * 0.04 * 0.4 + 100000000 * 0.8 - 500000000);
  assert.equal(value.price, (value.forwardEBITDA * 20 + 1000000000 - 100000000) / 300000000);
});
test('Single-variable sensitivities follow the economic sign and preserve average supply', () => {
  const baseline = calculateScenario(f, zero);
  assert.ok(calculateScenario(f, { ...zero, usdcGrowth: 0.20 }).price > baseline.price);
  assert.equal(calculateScenario(f, { ...zero, usdcGrowth: 0.20 }).averageUSDC, f.currentUSDC * 1.10);
  assert.ok(calculateScenario(f, { ...zero, yieldShift: -0.01 }).price < baseline.price);
  assert.ok(calculateScenario(f, { ...zero, retentionShift: -0.03 }).price < baseline.price);
  assert.ok(calculateScenario(f, { ...zero, opexGrowth: 0.20 }).price < baseline.price);
  assert.ok(calculateScenario(f, { ...zero, dilution: 0.10 }).price < baseline.price);
  assert.ok(calculateScenario(f, { ...zero, multiple: 25 }).price > baseline.price);
  assert.ok(calculateScenario({ ...f, futureCapitalCommitments: 500000000 }, zero).price < baseline.price);
});
test('Missing denominator and loss-making EBITDA do not create misleading target prices', () => {
  assert.equal(calculateScenario({ ...f, dilutedShares: null }, zero).price, null);
  assert.equal(calculateScenario({ ...f, annualAdjustedOpex: 5000000000 }, zero).price, null);
  assert.equal(calculateScenario(f, { ...zero, usdcGrowth: 1e308 }).price, null);
  assert.equal(calculateScenario(f, { ...zero, multiple: 1e308 }).price, null);
});
test('Wilder RSI seeds 14 differences, then smooths; flat prices yield neutral RSI', () => {
  const closes = [44.34,44.09,44.15,43.61,44.33,44.83,45.10,45.42,45.84,46.08,45.89,46.03,45.61,46.28,46.28,46.00];
  const bars = closes.map((close, i) => ({ date: dateAt(i), close, high: close + 1, low: close - 1 }));
  assert.ok(Math.abs(calculateIndicators(bars).rsi14 - 66.25) < 0.05);
  assert.equal(calculateIndicators(bars.slice(0, 14)).rsi14, null);
  assert.equal(calculateIndicators(bars.map(b => ({ ...b, close: 100 }))).rsi14, 50);
  assert.equal(calculateIndicators(bars.slice(0, 13)).atr14, null);
  assert.equal(calculateIndicators(bars).ma20, null);
});
test('Financial release and share effective date never become visible before next trading session', () => {
  const data = fixture();
  assert.equal(evaluateSnapshot(data, '2025-02-03').fundamentals.financialAvailableAt, null);
  assert.equal(evaluateSnapshot(data, '2025-02-04').fundamentals.financialAvailableAt, '2025-02-03');
  data.shares[0].effectiveDate = '2025-03-03';
  data.financials[0].dilutedShares = null;
  assert.equal(evaluateSnapshot(data, '2025-02-28').scenarios.base.price, null);
  assert.ok(evaluateSnapshot(data, '2025-03-03').scenarios.base.price > 0);
});
test('Current-day chain and rate observations cannot change that day valuation', () => {
  const data = fixture(), date = data.prices.CRCL[80].date;
  const baseline = evaluateSnapshot(data, date);
  data.usdc = data.usdc.map(row => row.date === date ? { ...row, usdc: 1000000000000000 } : row);
  data.rates = data.rates.map(row => row.date === date ? { ...row, sofr: 0.99 } : row);
  const later = evaluateSnapshot(data, date);
  assert.equal(later.scenarios.base.price, baseline.scenarios.base.price);
  assert.equal(later.indicators.usdc30d, baseline.indicators.usdc30d);
});
test('Appending future reports, shares and prices leaves historical outputs unchanged', () => {
  const data = fixture(), date = data.prices.CRCL[85].date;
  const initial = evaluateSnapshot(data, date);
  const changed = structuredClone(data);
  changed.financials.push({ ...changed.financials[0], availableAt: '2025-07-01', annualAdjustedOpex: 1 });
  changed.shares.push({ availableAt: '2025-07-01', effectiveDate: '2025-06-30', dilutedShares: 1, sourceUrl: 'https://example.test/future', verified: true });
  changed.prices.CRCL.push({ date: '2025-12-01', open: 1000, close: 1000, high: 1001, low: 999 });
  assert.deepEqual(evaluateSnapshot(changed, date), initial);
});
test('Current assumptions alter latest valuation but do not repaint historical markers or bands', () => {
  const data = fixture(100), asOf = data.prices.CRCL.at(-1).date;
  const baseline = analyze(data, {}, { asOf });
  const changed = analyze(data, { scenarios: { base: { multiple: 45 } }, dilutedSharesOverride: 400000000 }, { asOf });
  assert.notEqual(changed.latest.scenarios.base.price, baseline.latest.scenarios.base.price);
  assert.deepEqual(changed.history, baseline.history);
  assert.deepEqual(changed.backtest.equityCurve, baseline.backtest.equityCurve);
});
test('No financial history, stale financials and failed fresh-data sources suppress action', () => {
  const data = fixture(), date = data.prices.CRCL.at(-1).date;
  const absent = { ...data, financials: [], shares: [] };
  assert.equal(evaluateSnapshot(absent, date).buyScore, null);
  data.financials[0].availableAt = '2024-10-01';
  assert.equal(evaluateSnapshot(data, date).action, '数据不足');
  const cached = fixture(100);
  cached.metadata.sources.rates = { status: 'cached' };
  assert.equal(analyze(cached, {}, { asOf: cached.prices.CRCL.at(-1).date }).latest.action, '数据不足');
});
test('Manual event-risk gate forbids new buys without fabricating historical risk data', () => {
  const data = fixture(100), date = data.prices.CRCL.at(-1).date;
  assert.equal(evaluateSnapshot(data, date, { eventRisk: 'high' }).buyGate, false);
  assert.equal(evaluateSnapshot(data, date, { depeg: true }).buyGate, false);
});
test('Missing market-share denominator, unverified shares and stale benchmark are explicit score vetoes', () => {
  const source = fixture(100), date = source.prices.CRCL.at(-1).date;
  const noShare = structuredClone(source);
  noShare.usdc.forEach(row => { row.totalStablecoins = null; });
  assert.equal(evaluateSnapshot(noShare, date).buyScore, null);
  const unverified = structuredClone(source);
  unverified.shares[0].verified = false;
  assert.equal(evaluateSnapshot(unverified, date).buyScore, null);
  const staleBenchmark = structuredClone(source);
  staleBenchmark.prices.SPY = staleBenchmark.prices.SPY.slice(0, 10);
  assert.equal(evaluateSnapshot(staleBenchmark, date).buyScore, null);
});
test('Yield calibration uses the released quarter and exposes its source window', () => {
  const data = fixture(100), date = data.prices.CRCL.at(-1).date;
  data.financials[0].reserveYield = 0.037;
  data.rates.forEach(row => { row.sofr = row.date <= '2024-12-31' ? 0.04 : 0.03; });
  const result = evaluateSnapshot(data, date);
  assert.equal(result.fundamentals.reserveYieldCalibration.calibrated, true);
  assert.ok(Math.abs(result.fundamentals.reserveYieldSpread + 0.003) < 1e-10);
  assert.ok(Math.abs(result.fundamentals.currentReserveYield - 0.027) < 1e-10);
});
test('Explicit recurring revenue, contribution, cash and capital-commitment knobs change latest equity value', () => {
  const baseline = calculateScenario(f, zero);
  const adjusted = calculateScenario(f, zero, { annualRecurringOtherRevenueOverride: 200000000, otherContributionMarginOverride: 0.6, corporateNetCashOverride: 500000000, futureCapitalCommitmentsOverride: 200000000 });
  assert.equal(adjusted.annualRecurringOtherRevenue, 200000000);
  assert.equal(adjusted.otherContributionMargin, 0.6);
  assert.equal(adjusted.equityValue - baseline.equityValue, (120000000 - 80000000) * 20 - 500000000 - 100000000);
});
test('Known negative forward EBITDA is an economic exit flag, not missing data', () => {
  const data = fixture(100), date = data.prices.CRCL.at(-1).date;
  const result = evaluateSnapshot(data, date, { annualOpexOverride: 5000000000 });
  assert.equal(result.action, '退出复核');
  assert.equal(result.hardExit, true);
  assert.equal(result.buyGate, false);
  assert.equal(result.scenarios.base.price, null);
  assert.equal(result.buyScore, null);
  assert.deepEqual(result.blockers, []);
});
test('Next-session open executes after signal, includes costs, respects cash and position cap', () => {
  const data = fixture(12);
  data.prices.CRCL = data.prices.CRCL.map((b, i) => ({ ...b, open: 100 + i, close: 100 + i, high: 102 + i, low: 99 + i }));
  const history = data.prices.CRCL.map(b => ({ date: b.date, buyScore: 80, blockers: [], marker: { type: 'buy' } }));
  const replay = backtest(data, history, { initialCash: 100000, maxAllocation: 0.40, trancheFraction: 0.15, slippageBps: 10, feeBps: 5 });
  assert.equal(replay.trades[0].signalDate, data.prices.CRCL[0].date);
  assert.equal(replay.trades[0].date, data.prices.CRCL[1].date);
  assert.equal(replay.trades[0].price, data.prices.CRCL[1].open * 1.001);
  for (const trade of replay.trades) {
    assert.ok(trade.cash >= -1e-7);
    const open = data.prices.CRCL.find(b => b.date === trade.date).open;
    const exposure = trade.position * open / (trade.cash + trade.position * open);
    assert.ok(exposure <= 0.400001);
  }
  assert.equal(replay.buyAndHold.trades, 1);
  assert.ok(replay.buyAndHold.endingEquity > 100000);
});
test('Sell tranches cannot short and a full exit cannot sell nonexistent holdings', () => {
  const data = fixture(10), history = data.prices.CRCL.map((b, i) => ({ date: b.date, buyScore: 80, blockers: [], marker: { type: i < 2 ? 'buy' : i === 4 ? 'exit' : 'sell' } }));
  const replay = backtest(data, history);
  assert.ok(replay.trades.every(t => t.position >= 0 && t.cash >= 0));
  assert.equal(replay.equityCurve.at(-1).position, 0);
  const exit = replay.trades.findIndex(t => t.date === data.prices.CRCL[5].date);
  if (exit >= 0) assert.equal(replay.trades.slice(exit + 1).length, 0);
});
test('Signals have a cooldown and never score before sufficient public information', () => {
  const history = buildHistory(fixture(100));
  const indexes = history.map((row, i) => row.marker ? i : -1).filter(i => i >= 0);
  for (let i = 1; i < indexes.length; i++) assert.ok(indexes[i] - indexes[i - 1] >= DEFAULT_SETTINGS.cooldownSessions);
  for (const row of history.filter(row => row.date <= '2025-02-03')) assert.equal(row.buyScore, null);
});

test('Malformed roots, null rows, nonarrays, impossible calendar dates and bad prices fail safely', () => {
  for (const raw of [null, [], 'bad', { financials: 'bad', shares: null, prices: { CRCL: [null, { date: '2026-06-31', close: 10 }] }, rates: false, usdc: {} }]) {
    assert.doesNotThrow(() => analyze(raw));
    const result = analyze(raw);
    assert.ok(result.dataErrors.length > 0);
    assert.equal(result.latest.action, '数据不足');
  }
  const data = fixture(100); data.financials[0].periodEnd = '2024-11-31';
  const normalized = normalizeData(data);
  assert.equal(normalized.financials.length, 0);
  assert.ok(normalized.dataErrors.some(error => error.path.endsWith('periodEnd')));
  assert.equal(analyze(data, {}, { asOf: data.prices.CRCL.at(-1).date }).latest.action, '数据不足');
  assert.doesNotThrow(() => evaluateSnapshot({ prices: null, financials: [null] }, '2025-05-01', {}, { normalized: true, latest: true }));
});
test('Future malformed disclosures do not inject future data errors into past snapshots', () => {
  const data = fixture(100), date = data.prices.CRCL[80].date, baseline = evaluateSnapshot(data, date);
  data.financials.push({ ...data.financials[0], periodEnd: '2026-06-31', availableAt: '2026-08-05' });
  assert.deepEqual(evaluateSnapshot(data, date), baseline);
  const current = analyze(data, {}, { asOf: data.prices.CRCL.at(-1).date });
  assert.ok(current.dataErrors.length > 0);
});
test('Latest source gate requires all five fresh and internally consistent source timestamps', () => {
  const source = fixture(100), date = source.prices.CRCL.at(-1).date;
  assert.equal(evaluateSnapshot(source, date, {}, { latest: true, asOf: date }).dataBlockers.length, 0);
  for (const key of ['CRCL', 'SPY', 'usdc', 'totalStablecoins', 'rates']) {
    const absent = structuredClone(source); delete absent.metadata.sources[key];
    assert.equal(evaluateSnapshot(absent, date, {}, { latest: true, asOf: date }).buyScore, null);
    const stale = structuredClone(source); stale.metadata.sources[key].status = 'stale';
    assert.equal(evaluateSnapshot(stale, date, {}, { latest: true, asOf: date }).action, '数据不足');
  }
  for (const value of ['2025-02-30', '2025-5-01', null]) {
    const bad = structuredClone(source); bad.metadata.sources.rates.asOf = value;
    assert.equal(evaluateSnapshot(bad, date, {}, { latest: true, asOf: date }).buyScore, null);
  }
  const badTime = structuredClone(source); badTime.metadata.sources.usdc.fetchedAt = '2026-06-31T10:00:00Z';
  assert.equal(evaluateSnapshot(badTime, date, {}, { latest: true, asOf: date }).buyScore, null);
  const regressed = structuredClone(source); regressed.metadata.sources.CRCL.asOf = source.prices.CRCL.at(-2).date;
  assert.equal(evaluateSnapshot(regressed, date, {}, { latest: true, asOf: date }).buyScore, null);
});
test('Source verification flag cannot be bypassed by a true verified label', () => {
  const data = fixture(100), date = data.prices.CRCL.at(-1).date;
  data.shares[0].sourceVerified = false;
  assert.equal(evaluateSnapshot(data, date).buyScore, null);
  data.shares[0].sourceVerified = true; data.financials[0].sourceUrl = 'not-a-source';
  assert.equal(evaluateSnapshot(data, date).buyScore, null);
});
test('Reserve income uses nominal USDC while market share uses same-source dollar value', () => {
  const data = fixture(100), date = data.prices.CRCL.at(-1).date;
  const original = evaluateSnapshot(data, date);
  data.usdc.forEach(row => { row.usdcUSD = row.usdc * 0.95; });
  const changed = evaluateSnapshot(data, date);
  assert.equal(changed.scenarios.base.averageUSDC, original.scenarios.base.averageUSDC);
  assert.ok(Math.abs(changed.indicators.marketShare - original.indicators.marketShare * 0.95) < 1e-12);
  data.usdc.forEach(row => { delete row.usdcUSD; });
  assert.ok(evaluateSnapshot(data, date).indicators.marketShare > 0);
  assert.equal(evaluateSnapshot(data, date, {}, { latest: true, asOf: date }).action, '数据不足');
});
test('Checklist passes exactly the action gates, including null scores and independent economic exit', () => {
  const data = fixture(100), date = data.prices.CRCL.at(-1).date;
  for (const settings of [{}, { eventRisk: 'high' }, { annualOpexOverride: 5000000000 }, { scenarios: { base: { multiple: 60 } } }]) {
    const snapshot = evaluateSnapshot(data, date, settings), checklist = decisionChecklist(snapshot);
    assert.equal(snapshot.buyGate, checklist.buy.every(row => row.pass));
    assert.equal(snapshot.sellGate, checklist.reduce.every(row => row.pass));
    assert.equal(snapshot.exitGate, checklist.exit.every(row => row.pass));
    assert.ok(Object.values(checklist).flat().every(row => ['id', 'label', 'observed', 'target', 'pass', 'kind'].every(key => Object.hasOwn(row, key))));
    assert.ok(Object.values(checklist).flat().every(row => typeof row.observed === 'string' && typeof row.target === 'string'));
  }
  assert.equal(decisionChecklist({ buyScore: null, sellScore: null }).buy.find(row => row.id === 'buy-score').pass, false);
});
test('Latest reevaluation retains complete diagnostic cards after any parameter change', () => {
  const data = fixture(100), date = data.prices.CRCL.at(-1).date;
  const initial = evaluateSnapshot(data, date, {}, { latest: true, asOf: date });
  const changed = evaluateSnapshot(data, date, { scenarios: { base: { multiple: 40 } } }, { latest: true, asOf: date });
  assert.ok(changed.reverseValuation && changed.valuationContext && changed.modelComparison && changed.checklist);
  assert.notEqual(changed.reverseValuation.requiredEBITDA, initial.reverseValuation.requiredEBITDA);
  assert.equal(changed.valuationContext.percentiles.ps.count, initial.valuationContext.percentiles.ps.count);
  const brief = evaluateSnapshot(data, date, {}, { latest: true, asOf: date, diagnostics: false });
  assert.equal(brief.reverseValuation, undefined);
  assert.equal(brief.valuationContext, undefined);
  assert.equal(brief.action, initial.action);
  assert.deepEqual(brief.checklist, initial.checklist);
});
test('Reverse valuation reproduces market price independently for all five variables and overrides', () => {
  const data = fixture(100), date = data.prices.CRCL.at(-1).date;
  const settings = { corporateNetCashOverride: 700000000, futureCapitalCommitmentsOverride: 200000000, annualRecurringOtherRevenueOverride: 180000000, otherContributionMarginOverride: 0.6, annualOpexOverride: 600000000, dilutedSharesOverride: 320000000, annualSBCPayrollTaxOverride: 12000000, annualRecurringSBCOverride: 100000000, compensationMode: 'cash', financingDilution: 0.03 };
  const snapshot = evaluateSnapshot(data, date, settings);
  snapshot.price = snapshot.scenarios.base.price * 1.10;
  const reverse = reverseValuation(snapshot);
  for (const check of Object.values(reverse.checks)) {
    assert.equal(check.achievable, true);
    assert.ok(Math.abs(check.reproducedPrice - snapshot.price) < 1e-7);
  }
  assert.equal(reverse.assumptions.corporateNetCash, 700000000);
  assert.equal(reverse.assumptions.compensationMode, 'cash');
});
test('Unachievable implied rates or retention remain null and are explicitly explained', () => {
  const data = fixture(100), date = data.prices.CRCL.at(-1).date, snapshot = evaluateSnapshot(data, date);
  snapshot.price = 100000;
  const reverse = reverseValuation(snapshot);
  assert.equal(reverse.requiredReserveYield, null);
  assert.equal(reverse.requiredReserveRetention, null);
  assert.equal(reverse.checks.reserveYield.achievable, false);
  assert.match(reverse.checks.reserveYield.reason, /经济边界/);
  assert.ok(reverse.requiredMultiple > 60);
  assert.match(reverse.checks.multiple.reason, /数学可解/);
  assert.equal(reverseValuation({}).requiredEBITDA, null);
});
test('Issuer sensitivity bridge respects quarter day count and does not replace average retention', () => {
  const bridgeF = { ...f, periodEnd: '2025-06-30', financialAvailableAt: '2025-08-01', avgUSDC: 80000000000, reserveYield: 0.04, reserveRevenue: 800000000, distributionAndTransactionCosts: 480000000,
    sensitivity: { availableAt: '2025-08-01', verified: true, anchorUSDC: 80000000000, rldcDeltaPer100bps: 400000000, sourceUrl: 'https://example.test/sensitivity' } };
  const baseline = calculateScenario(bridgeF, zero, { valuationMethod: 'issuer-sensitivity' });
  assert.equal(baseline.netReserveBridge.quarterDays, 91);
  assert.ok(Math.abs(baseline.retainedReserveRevenue - 320000000 * 365 / 91) < 1e-6);
  const higher = calculateScenario(bridgeF, { ...zero, yieldShift: 0.01 }, { valuationMethod: 'issuer-sensitivity' });
  assert.ok(Math.abs(higher.retainedReserveRevenue - baseline.retainedReserveRevenue - 400000000) < 1e-6);
  assert.equal(higher.reserveRetention, 0.4);
  const snapshot = { price: higher.price, fundamentals: bridgeF, decisionSettings: { valuationMethod: 'issuer-sensitivity', annualSBCPayrollTaxOverride: 0, scenarios: { base: zero } } };
  const reverse = reverseValuation(snapshot);
  for (const check of Object.values(reverse.checks)) assert.ok(check.achievable && Math.abs(check.reproducedPrice - snapshot.price) < 1e-7);
  bridgeF.sensitivity.availableAt = '2025-08-02';
  assert.equal(calculateScenario(bridgeF, zero, { valuationMethod: 'issuer-sensitivity' }).price, null);
});
test('SBC payroll and cash replacement are mutually explicit and never double-count dilution or capitalized SBC', () => {
  const withSBC = { ...f, sbcPayrollTaxes: 7637000, stockBasedCompensationExpense: 53599000, capitalizedSBC: 13800000 };
  const equity = calculateScenario(withSBC, { ...zero, dilution: 0.10 }, { compensationMode: 'equity', financingDilution: 0.03 });
  const cash = calculateScenario(withSBC, { ...zero, dilution: 0.10 }, { compensationMode: 'cash', financingDilution: 0.03 });
  assert.equal(equity.annualSBCPayrollTax, 30548000);
  assert.equal(cash.annualRecurringSBC, 214396000);
  assert.equal(equity.forwardEBITDA - cash.forwardEBITDA, 214396000);
  assert.equal(cash.dilutedShares, f.dilutedShares * 1.03);
  assert.equal(equity.dilutedShares, f.dilutedShares * 1.10 * 1.03);
  assert.equal(calculateScenario(withSBC, zero, { opexIncludesSBCPayrollTax: true }).annualSBCPayrollTax, 0);
  assert.equal(calculateScenario(withSBC, zero, HISTORICAL_SETTINGS_V1).annualSBCPayrollTax, 0);
  assert.equal(calculateScenario({ ...f, stockBasedCompensationExpense: null }, zero, { compensationMode: 'cash' }).price, null);
});
test('Changing current valuation method and SBC modes never repaints the frozen historical formula', () => {
  const data = fixture(100), asOf = data.prices.CRCL.at(-1).date;
  const original = analyze(data, {}, { asOf });
  const changed = analyze(data, { compensationMode: 'cash', financingDilution: 0.10, valuationMethod: 'issuer-sensitivity' }, { asOf });
  assert.equal(changed.historyFingerprint, original.historyFingerprint);
  assert.deepEqual(changed.history, original.history);
  assert.deepEqual(changed.backtest.equityCurve, original.backtest.equityCurve);
  assert.equal(changed.latest.scenarios.base.price, null);
});
test('Historical valuation percentiles are cumulative and never include future ratios', () => {
  const history = buildHistory(fixture(100)), row = history[80];
  const prefix = history.slice(0, 80);
  const old = valuationContext(row, prefix);
  const later = valuationContext(row, [...prefix, ...history.slice(81)]);
  assert.deepEqual(later, old);
  assert.ok(old.percentiles.ps.count > 0);
  assert.ok(old.percentiles.ps.percentile >= 0 && old.percentiles.ps.percentile <= 100);
  assert.match(old.definition, /非TTM/);
  assert.ok(row.valuationContext.ps > 0);
});
test('Account plan is unconfigured without explicit balances and rejects double-counted assets', () => {
  assert.equal(planAllocation({}).configured, false);
  const snapshot = { price: 100, scenarios: { bear: { price: 50 } }, buyGate: true, dataBlockers: [], decisionSettings: {} };
  assert.equal(planAllocation(snapshot, { portfolioValue: 100000, currentHoldingValue: 50000, availableCash: 60000, maxWeight: 0.6, maxStressLoss: 20000 }).configured, false);
});
test('Allocation budget is the minimum of cash, weight and dollar stress-loss headroom', () => {
  const snapshot = { price: 100, scenarios: { bear: { price: 50 } }, buyGate: true, dataBlockers: [], decisionSettings: {} };
  const inputs = { portfolioValue: 100000, currentHoldingValue: 10000, availableCash: 60000, maxWeight: 0.5, maxStressLoss: 15000 };
  const plan = planAllocation(snapshot, inputs);
  assert.equal(plan.stressLossBudget, 15000);
  assert.equal(plan.stressLossUsed, 5000);
  assert.equal(plan.weightHeadroom, 40000);
  assert.equal(plan.hypotheticalBuyValue, 20000);
  assert.equal(plan.actionableBuyValue, 20000);
  const zero = planAllocation(snapshot, { ...inputs, maxStressLoss: 0 });
  assert.equal(zero.actionableBuyValue, 0);
  const constrainedCash = planAllocation(snapshot, { ...inputs, availableCash: 5000 });
  assert.equal(constrainedCash.actionableBuyValue, 5000);
});
test('Allocation risk gates preserve hypothetical budget but suppress all actionable buys', () => {
  const snapshot = { price: 100, scenarios: { bear: { price: 50 } }, buyGate: true, dataBlockers: [], decisionSettings: {} };
  const inputs = { portfolioValue: 100000, currentHoldingValue: 0, availableCash: 100000, maxWeight: 0.6, maxStressLoss: 20000 };
  for (const altered of [{ ...snapshot, hardExit: true }, { ...snapshot, buyGate: false }, { ...snapshot, dataBlockers: ['缺失'] }, { ...snapshot, decisionSettings: { depeg: true } }, { ...snapshot, decisionSettings: { eventRisk: 'high' } }]) {
    const plan = planAllocation(altered, inputs);
    assert.equal(plan.actionableBuyValue, 0);
    assert.equal(plan.hypotheticalBuyValue, 40000);
  }
});
test('Existing holdings exceeding risk or weight budgets create capped reduction needs without shorting', () => {
  const snapshot = { price: 100, scenarios: { bear: { price: 50 } }, buyGate: true, dataBlockers: [], decisionSettings: {} };
  const plan = planAllocation(snapshot, { portfolioValue: 100000, currentHoldingValue: 50000, availableCash: 50000, maxWeight: 0.2, maxStressLoss: 5000 });
  assert.equal(plan.needReduceValue, 40000);
  assert.equal(plan.actionableBuyValue, 0);
  const proposed = planAllocation(snapshot, { portfolioValue: 100000, currentHoldingValue: 0, availableCash: 100000, maxWeight: 0.5, maxStressLoss: 10000, entryPrice: 200 });
  assert.equal(proposed.lossRate, 0.75);
  assert.ok(Math.abs(proposed.hypotheticalBuyValue - 10000 / 0.75) < 1e-8);
});
test('Same-allocation hold and fixed DCA use next opening prices, identical fees and original cash only', () => {
  const data = fixture(65), history = data.prices.CRCL.map(b => ({ date: b.date, buyScore: 80, blockers: [], marker: null }));
  const replay = backtest(data, history, { initialCash: 100000, maxAllocation: 0.4, trancheFraction: 0.1, slippageBps: 10, feeBps: 5 });
  assert.equal(replay.benchmarkTrades.sameAllocationHold[0].date, data.prices.CRCL[1].date);
  assert.equal(replay.benchmarkTrades.sameAllocationHold[0].price, data.prices.CRCL[1].open * 1.001);
  assert.deepEqual(replay.benchmarkTrades.scheduledDCA.map(trade => trade.date), [1, 21, 41, 61].map(index => data.prices.CRCL[index].date));
  assert.ok(replay.equityCurve.every(row => row.dcaCash >= 0));
  assert.equal(replay.strategy.endingEquity, 100000);
  assert.equal(replay.coverage.status, 'inactive');
  assert.equal(replay.coverage.winRate, null);
});
test('Replay coverage counts public report windows and uses realized sell events for win rate', () => {
  const data = fixture(65), rows = buildHistory(data);
  const covered = backtest(data, rows);
  assert.ok(covered.coverage.scoredDays > 0 && covered.coverage.reportWindows === 1);
  const history = data.prices.CRCL.map((b, index) => ({ date: b.date, buyScore: 80, blockers: [], buyGate: index === 0, marker: index === 0 ? { type: 'buy' } : index === 4 ? { type: 'exit' } : null }));
  const replay = backtest(data, history);
  assert.equal(replay.coverage.buyEpisodes, 1);
  assert.equal(replay.coverage.actualTrades, 2);
  assert.equal(replay.coverage.closedTradeEvents, 1);
  assert.ok([0, 1].includes(replay.coverage.winRate));
  assert.equal(replay.coverage.status, 'active');
});
test('Reconstruction fingerprints refresh after input revisions but current knobs cannot change historical identity', () => {
  const data = fixture(65), asOf = data.prices.CRCL.at(-1).date;
  const initial = analyze(data, {}, { asOf });
  const knob = analyze(data, { scenarios: { base: { multiple: 30 } } }, { asOf });
  assert.equal(knob.historyFingerprint, initial.historyFingerprint);
  data.usdc[10].usdc += 1;
  const revised = analyze(data, {}, { asOf });
  assert.notEqual(revised.historyFingerprint, initial.historyFingerprint);
  assert.match(revised.fingerprintPolicy, /不证明/);
  assert.equal(Object.isFrozen(revised.history), true);
  assert.equal(Object.isFrozen(data.financials[0]), false);
});
