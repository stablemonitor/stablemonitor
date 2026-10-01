import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, analyze, buildHistory, calculateScenario, calculateIndicators, evaluateSnapshot, backtest } from '../assets/crcl-model.js';

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
    usdc.push({ date: dateAt(i), usdc: 80000000000 * (1 + i * 0.0005), totalStablecoins: 200000000000 });
    rates.push({ date: dateAt(i), sofr: 0.04 });
  }
  const financial = { periodEnd: '2024-12-31', availableAt: '2025-02-03', avgUSDC: 80000000000, reserveYield: 0.04, reserveRevenue: 800000000, distributionCosts: 480000000, reserveRetention: 0.4,
    annualRecurringOtherRevenue: 100000000, otherContributionMargin: 0.8, annualAdjustedOpex: 500000000, corporateNetCash: 1000000000, futureCapitalCommitments: 100000000,
    dilutedShares: 300000000, verified: true, sharesProxy: true };
  return { prices: { CRCL: prices, SPY: prices.map(b => ({ ...b, open: 100, high: 101, low: 99, close: 100 })) }, usdc, rates,
    financials: [financial], shares: [{ effectiveDate: '2024-12-31', availableAt: '2025-02-03', dilutedShares: 300000000, verified: true }], metadata: { sources: {} } };
}
const f = { currentUSDC: 80000000000, currentReserveYield: 0.04, reserveRetention: 0.4, annualAdjustedOpex: 500000000, dilutedShares: 300000000,
  annualRecurringOtherRevenue: 100000000, otherContributionMargin: 0.8, corporateNetCash: 1000000000, futureCapitalCommitments: 100000000 };
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
  changed.shares.push({ availableAt: '2025-07-01', effectiveDate: '2025-06-30', dilutedShares: 1 });
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
