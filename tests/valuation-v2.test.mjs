import test from 'node:test';
import assert from 'node:assert/strict';
import { V2_DEFAULTS, buildReserveRatePath, summarizeRelativeBasis, calculateDCF, buildValuationV2, reverseValuationV2 } from '../assets/crcl-valuation-v2.js';
import { DEFAULT_SETTINGS, HISTORICAL_SETTINGS_V1 } from '../assets/crcl-model.js';

function fixture(endDate = '2026-10-01') {
  const prices = [], usdc = [], rates = [];
  let index = 0;
  for (let timestamp = Date.parse('2025-01-01T00:00:00Z'); timestamp <= Date.parse(`${endDate}T00:00:00Z`); timestamp += 86400000) {
    const date = new Date(timestamp).toISOString().slice(0, 10);
    if (date < endDate) { usdc.push({ date, usdc: 75000000000, usdcUSD: 75000000000, totalStablecoins: 300000000000 }); rates.push({ date, sofr: date < '2026-07-01' ? 0.0362 : 0.039 }); }
    const weekday = new Date(timestamp).getUTCDay();
    if (date >= '2025-06-05' && weekday !== 0 && weekday !== 6) {
      const close = 70 + 15 * Math.sin(index++ / 30);
      prices.push({ date, open: close, high: close + 1, low: close - 1, close, volume: 10000 });
    }
  }
  const periods = [
    ['2025Q2', '2025-06-30', '2025-08-12', 130000000], ['2025Q3', '2025-09-30', '2025-11-12', 150000000],
    ['2025Q4', '2025-12-31', '2026-02-25', 155000000], ['2026Q1', '2026-03-31', '2026-05-11', 145000000],
    ['2026Q2', '2026-06-30', '2026-08-05', 143000000]
  ];
  const financials = periods.map(([period, periodEnd, availableAt, adjustedEBITDA]) => ({ period, periodEnd, availableAt, verified: true, sourceUrl: `https://example.test/${period}`, reserveYield: 0.035,
    avgUSDC: 75000000000, reserveRevenue: 650000000, distributionAndTransactionCosts: 390000000, distributionCosts: 392000000, reserveRetention: 0.4,
    otherRevenue: 35000000, totalRevenue: 685000000, rldc: 293000000, adjustedEBITDA, annualAdjustedOpex: 570000000, quarterAdjustedOpex: 140000000,
    annualRecurringOtherRevenue: 160000000, otherContributionMargin: 0.9, sbcPayrollTaxes: 7000000, stockBasedCompensationExpense: 50000000,
    corporateCash: 1700000000, corporateDebt: 0, corporateHeldStablecoinReserves: 900000000, arcPresaleCashExcluded: period === '2026Q2' ? 222000000 : 0,
    corporateNetCash: 1478000000, dilutedShares: 270000000, futureCapitalCommitments: 0, customerReserveCash: 75000000000 }));
  const shares = financials.map(row => ({ effectiveDate: row.periodEnd, availableAt: row.availableAt, dilutedShares: 270000000, verified: true, sourceUrl: row.sourceUrl }));
  const fetchedAt = `${endDate}T22:00:00Z`;
  const sources = Object.fromEntries(['CRCL', 'SPY', 'usdc', 'totalStablecoins', 'rates'].map(key => [key, { status: 'fresh', asOf: ['CRCL', 'SPY'].includes(key) ? prices.at(-1).date : usdc.at(-1).date, fetchedAt, url: `https://example.test/${key}` }]));
  const data = { schemaVersion: 1, prices: { CRCL: prices, SPY: prices.map(row => ({ ...row, open: 100, close: 100, high: 101, low: 99 })) }, usdc, rates, financials, shares, metadata: { sources, generatedAt: fetchedAt } };
  const context = {
    preparedAt: endDate,
    fedSnapshots: [{ availableAt: '2026-09-16', verified: true, currentFedMidpoint: 0.03875, yearEndRates: { 2026: 0.041, 2027: 0.041, 2028: 0.039, 2029: 0.036 }, longRunRate: 0.032, longRunYear: 2031, sourceUrls: ['https://example.test/fed'] }],
    capitalInputs: { availableAt: '2026-08-05', verified: true, sourceUrls: ['https://example.test/capital'], annualCashCapex: 71600000, annualDA: 119584000 },
    corporateEvents: [{ id: 'completed', availableAt: '2026-09-22', effectiveDate: '2026-09-17', status: 'completed', verified: true, cashDelta: 100000000, sharesDelta: 1237011, sourceUrl: 'https://example.test/completed' },
      { id: 'pending', availableAt: '2026-09-08', status: 'pending', verified: true, assumedClosingDate: '2027-06-30', stockConsideration: 400000000, retentionStock: 25000000, retentionStartMonths: 27, sourceUrl: 'https://example.test/pending' }],
    financialRecasts: { availableAt: '2026-05-11', adjustedEBITDANewDefinition: { '2025Q2': 135000000, '2025Q3': 155000000, '2025Q4': 160000000 } },
    discountAnchors: { treasury10Year: 0.0524 }
  };
  return { data, context };
}
const build = (f, settings = {}, asOf = '2026-10-01') => buildValuationV2(f.data, f.context, settings, { asOf, dataAsOf: f.data.prices.CRCL.at(-1).date });
const closeEnough = (actual, expected, tolerance = 1e-7) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);

test('Five years use an explicit end/average supply path and growth fades, not a repeated management promise', () => {
  const f = fixture(), model = build(f), years = model.cases.base.years;
  assert.equal(years.length, 5);
  assert.equal(model.current.currentUSDC, 75000000000);
  assert.equal(years[0].endUSDC, 75000000000 * 1.25);
  assert.equal(years[0].averageUSDC, 75000000000 * 1.125);
  assert.equal(years[4].usdcGrowth, 0.12);
  assert.ok(years[4].endUSDC < 75000000000 * 1.40 ** 5);
  assert.match(model.current.reserveForecastAnchor, /名义/);
});
test('Calendar SEP year-end nodes are integrated across Oct1-to-Oct1 rather than mistaken for annual means', () => {
  const f = fixture(), path = buildReserveRatePath(f.context, '2026-10-01', 0.039, -0.0012);
  assert.equal(path.valid, true);
  const daysToYearEnd = (Date.parse('2026-12-31') - Date.parse('2026-10-01')) / 86400000;
  const current = 0.039 - 0.0012, yearEnd = 0.041 + (0.039 - 0.03875) - 0.0012;
  const expected = ((current + yearEnd) / 2 * daysToYearEnd + yearEnd * (365 - daysToYearEnd)) / 365;
  closeEnough(path.years[0].reserveYield, expected, 1e-12);
  assert.notEqual(path.years[0].reserveYield, path.years[0].endYield);
  assert.equal(path.years[0].startDate, '2026-10-01');
  assert.equal(path.years[0].endDate, '2027-10-01');
  assert.equal(path.nodes.find(node => node.date === '2031-12-31').fedRate, 0.032);
  assert.equal(path.nodes.find(node => node.date === '2030-12-31').status, 'author_long_run_convergence');
});
test('A future Fed release or invalid percent unit cannot be backfilled as the known rate path', () => {
  const f = fixture();
  assert.equal(buildReserveRatePath(f.context, '2026-09-16', 0.039, -0.0012).valid, false);
  const bad = structuredClone(f.context); bad.fedSnapshots[0].yearEndRates[2026] = 4.1;
  assert.equal(buildReserveRatePath(bad, '2026-10-01', 0.039, -0.0012).valid, false);
  const initial = build(f);
  f.context.fedSnapshots.push({ ...f.context.fedSnapshots[0], availableAt: '2027-01-01', yearEndRates: { 2027: 0.10 } });
  closeEnough(build(f).cases.base.price, initial.cases.base.price);
});
test('Long Treasury discount anchor never replaces the short reserve yield or automatically determines the hurdle', () => {
  const f = fixture(), before = build(f);
  f.context.discountAnchors.treasury10Year = 0.15;
  const after = build(f);
  assert.equal(after.current.reserveYield, before.current.reserveYield);
  assert.equal(after.cases.base.price, before.cases.base.price);
  assert.equal(after.settings.scenarios.base.requiredReturn, 0.12);
});
test('FCFF subtracts taxes, cash reinvestment and corporate NWC without re-adding D&A or financing customer reserves', () => {
  const f = fixture(), model = build(f), year = model.cases.base.years[0];
  closeEnough(year.fcff, year.cashEBITDAProxy - year.cashTaxes - year.cashCapex - year.deltaNWC, 1e-6);
  assert.ok(Math.abs(year.deltaNWC) < 100000000);
  const changed = structuredClone(f); changed.data.financials.forEach(row => { row.customerReserveCash *= 1000; });
  closeEnough(build(changed).cases.base.methods.dcf.price, model.cases.base.methods.dcf.price);
  assert.equal(model.current.customerReserveCashIncluded, 0);
});
test('D&A only creates a tax shield; its increase is never an additional EBITDA cash inflow', () => {
  const f = fixture(), baseline = build(f), moreDA = build(f, { annualDAOverride: 139584000 });
  const expectedShield = 20000000 * 1.06 * 0.21;
  closeEnough(moreDA.cases.base.years[0].fcff - baseline.cases.base.years[0].fcff, expectedShield, 1e-6);
  assert.equal(moreDA.cases.base.years[0].cashEBITDAProxy, baseline.cases.base.years[0].cashEBITDAProxy);
});
test('Current company cash uses explicit corporate liquidity research haircut and excludes ARC and customer cash', () => {
  const model = build(fixture());
  assert.equal(model.current.corporateNetCash, 1700000000 - 222000000 + 900000000 * 0.8 + 100000000);
  assert.equal(model.current.currentShares, 270000000 + 1237011);
  assert.equal(model.current.customerReserveCashIncluded, 0);
  const noLiquidity = build(fixture(), { corporateUSDCUsability: 0 });
  assert.equal(model.current.corporateNetCash - noLiquidity.current.corporateNetCash, 720000000);
});
test('Completed financing is public-availability dated, deduplicated and not re-added after a reporting period includes it', () => {
  const f = fixture('2026-10-16');
  const before = build(f, {}, '2026-09-22'), after = build(f, {}, '2026-09-23');
  assert.equal(after.current.corporateNetCash - before.current.corporateNetCash, 100000000);
  assert.equal(after.current.currentShares - before.current.currentShares, 1237011);
  f.context.corporateEvents.push({ ...f.context.corporateEvents[0] });
  assert.equal(build(f, {}, '2026-09-23').current.corporateNetCash, after.current.corporateNetCash);
  const q3 = { ...f.data.financials.at(-1), period: '2026Q3', periodEnd: '2026-09-30', availableAt: '2026-10-15', corporateCash: 1800000000, dilutedShares: 271237011 };
  f.data.financials.push(q3); f.data.shares.push({ effectiveDate: q3.periodEnd, availableAt: q3.availableAt, dilutedShares: q3.dilutedShares, verified: true, sourceUrl: q3.sourceUrl });
  const reported = build(f, {}, '2026-10-16');
  assert.equal(reported.current.corporateNetCash, after.current.corporateNetCash);
  assert.equal(reported.current.currentShares, after.current.currentShares);
  assert.equal(reported.current.excludedEvents.length, 1);
});
test('Pending stock deal is default-off, not current cash or shares, and includes delayed RSUs only in optional stress', () => {
  const f = fixture(), base = build(f), stress = build(f, { includePendingDeals: true });
  assert.equal(base.current.corporateNetCash, stress.current.corporateNetCash);
  assert.equal(base.current.currentShares, stress.current.currentShares);
  assert.ok(stress.cases.base.years[0].pendingShares > 0);
  assert.equal(stress.cases.base.years[0].pendingShares, 400000000 / base.current.price);
  assert.equal(stress.cases.base.years[1].pendingEvents.filter(event => event.type === 'retention_stock_stress').length, 0);
  assert.ok(stress.cases.base.years[2].pendingEvents.some(event => event.type === 'retention_stock_stress'));
  assert.equal(stress.cases.base.years[0].cashEBITDAProxy, base.cases.base.years[0].cashEBITDAProxy);
  assert.ok(stress.cases.base.price < base.cases.base.price);
  assert.ok(stress.cases.base.warnings.some(warning => warning.includes('不能当完整交易损益')));
});
test('Own-market relative basis uses four consecutive public quarters and only then available recasts', () => {
  const f = fixture(), basis = summarizeRelativeBasis(f.data, f.context, {}, '2026-10-01');
  assert.equal(basis.method, 'historical_ttm');
  assert.ok(basis.count >= 20);
  assert.equal(basis.sourceFirstDate, '2026-05-12');
  assert.equal(basis.latestTTMAdjustedEBITDA, 155000000 + 160000000 + 145000000 + 143000000);
  assert.ok(basis.multiples.bear <= basis.multiples.base && basis.multiples.base <= basis.multiples.bull);
  const futureRecast = structuredClone(f.context); futureRecast.financialRecasts.availableAt = '2027-01-01';
  assert.equal(summarizeRelativeBasis(f.data, futureRecast, {}, '2026-10-01').latestTTMAdjustedEBITDA, 150000000 + 155000000 + 145000000 + 143000000);
});
test('Short history or missing quarterly gaps uses labelled author multiples without inventing peers', () => {
  const f = fixture(), short = structuredClone(f.data);
  short.prices.CRCL = short.prices.CRCL.slice(-10);
  const basis = summarizeRelativeBasis(short, f.context, {}, '2026-10-01');
  assert.equal(basis.method, 'author_fallback');
  assert.deepEqual(basis.multiples, { bear: 24, base: 30, bull: 36 });
  const missing = structuredClone(f.data); missing.financials = missing.financials.filter(row => row.period !== '2025Q4');
  assert.equal(summarizeRelativeBasis(missing, f.context, {}, '2026-10-01').method, 'author_fallback');
});
test('Historical market multiple never applies current shares or corporate balance backwards', () => {
  const f = fixture(), basis = summarizeRelativeBasis(f.data, f.context, {}, '2026-10-01');
  const before = basis.observations.find(row => row.date === '2026-09-22'), after = basis.observations.find(row => row.date === '2026-09-23');
  assert.equal(after.currentShares - before.currentShares, 1237011);
  assert.equal(after.corporateNetCash - before.corporateNetCash, 100000000);
  const earlier = basis.observations.find(row => row.date === '2026-06-01');
  assert.equal(earlier.corporateNetCash, 1700000000 + 900000000 * 0.8);
});
test('Market observation ranks stop at asOf and current close is not a direct intrinsic price anchor', () => {
  const f = fixture(), baseline = build(f), withFuture = structuredClone(f);
  withFuture.data.prices.CRCL.push({ date: '2027-01-01', open: 1000, high: 1001, low: 999, close: 1000, volume: 100000 });
  assert.deepEqual(summarizeRelativeBasis(withFuture.data, withFuture.context, {}, '2026-10-01'), baseline.relativeBasis);
  const last = f.data.prices.CRCL.at(-1); last.close = last.open = 500; last.high = 501; last.low = 499;
  const changed = build(f);
  assert.equal(changed.cases.base.methods.dcf.price, baseline.cases.base.methods.dcf.price);
  assert.ok(Math.abs(changed.cases.base.price - baseline.cases.base.price) < 2);
});
test('DCF and relative blend only once; 3/5-year exits are diagnostics and severe stress is outside the normal interval', () => {
  const model = build(fixture()), base = model.cases.base;
  closeEnough(base.price, (base.methods.dcf.price + base.methods.relative.price) / 2);
  assert.equal(base.methods.growthExit3.diagnostic, true);
  assert.equal(base.methods.growthExit5.diagnostic, true);
  assert.equal(model.consensusBand.low, Math.min(model.cases.bear.price, model.cases.base.price, model.cases.bull.price));
  assert.ok(model.cases.severeStress.price < model.consensusBand.low);
  assert.equal(model.cases.severeStress.price, model.cases.severeStress.methods.dcf.price);
  assert.equal(model.cases.severeStress.methods.relative.blendEligible, false);
  assert.equal(model.cases.severeStress.assumptions.methodWeight.relative, 0);
  assert.match(model.cases.severeStress.pricePolicy, /非底价/);
  const relativeStyle = build(fixture(), { relativeWeight: 1 });
  assert.equal(relativeStyle.cases.severeStress.price, model.cases.severeStress.price);
  assert.equal(model.confidence.level, 'limited');
});
test('PV bridge sums to DCF per-share value and net corporate cash is added exactly once', () => {
  const f = fixture(), model = build(f), dcf = model.cases.base.methods.dcf;
  closeEnough(Object.values(dcf.pvBridge).reduce((sum, value) => sum + value, 0), dcf.price);
  closeEnough(dcf.price, dcf.pvCashFlows + dcf.pvTerminal + model.current.corporateNetCash / model.current.currentShares);
  const extra = build(f, { corporateNetCashOverride: model.current.corporateNetCash + 100000000 });
  closeEnough(extra.cases.base.methods.dcf.price - dcf.price, 100000000 / model.current.currentShares);
});
test('Stable shareholder dilution reduces terminal per-share growth and Gordon invalidity remains null', () => {
  const model = build(fixture()), dcf = model.cases.base.methods.dcf;
  closeEnough(dcf.terminalPerShareGrowth, 1.025 / 1.01 - 1, 1e-12);
  const invalid = calculateDCF(model.cases.base.years, { ...V2_DEFAULTS.scenarios.base, requiredReturn: 0.005 }, model.current, V2_DEFAULTS);
  assert.equal(invalid.price, null);
  assert.match(invalid.reason, /每股终值增长/);
});
test('Terminal year six recomputes ending-balance income at steady yield, taxes, reinvestment and shareholder claims', () => {
  const model = build(fixture()), dcf = model.cases.base.methods.dcf, fifth = model.cases.base.years[4], sixth = dcf.terminalYear6;
  assert.equal(sixth.startUSDC, fifth.endUSDC);
  assert.equal(sixth.endUSDC, fifth.endUSDC * 1.025);
  closeEnough(sixth.averageUSDC, (sixth.startUSDC + sixth.endUSDC) / 2, 0.0001);
  assert.equal(sixth.reserveYield, model.current.longRunReserveYield);
  assert.notEqual(sixth.reserveYield, fifth.reserveYield);
  assert.equal(sixth.reserveRetention, fifth.reserveRetention);
  closeEnough(sixth.netReserveIncome, sixth.averageUSDC * sixth.reserveYield * sixth.reserveRetention, 0.0001);
  closeEnough(sixth.deltaNWC, (sixth.rldcProxy - fifth.rldcProxy) * 0.03);
  closeEnough(sixth.fcff, sixth.cashEBITDAProxy - sixth.cashTaxes - sixth.cashCapex - sixth.deltaNWC, 0.0001);
  assert.equal(sixth.shares, fifth.shares * 1.01);
  assert.equal(dcf.cashPerShare6, sixth.fcff / sixth.shares);
  closeEnough(dcf.pvTerminal, dcf.cashPerShare6 / (0.12 - dcf.terminalPerShareGrowth) / fifth.discountFactor);
  assert.equal(sixth.normalizedPeriodDays, 365);
  assert.equal(sixth.calendarDays, 366);
});
test('Adding known cash PP&E to software reinvestment reduces FCFF and DCF without double-charging EBITDA', () => {
  const f = fixture(), softwareOnly = build(f);
  f.context.capitalInputs.annualCashCapex = (35800000 + 10400000) * 2;
  const allKnown = build(f);
  assert.equal(allKnown.cases.base.years[0].cashEBITDAProxy, softwareOnly.cases.base.years[0].cashEBITDAProxy);
  closeEnough(softwareOnly.cases.base.years[0].fcff - allKnown.cases.base.years[0].fcff, 20800000 * 1.06, 0.0001);
  assert.ok(allKnown.cases.base.methods.dcf.price < softwareOnly.cases.base.methods.dcf.price);
  assert.equal(allKnown.cases.base.methods.relative.price, softwareOnly.cases.base.methods.relative.price);
  assert.equal(allKnown.cases.base.years[0].cashTaxes, softwareOnly.cases.base.years[0].cashTaxes);
});
test('Equity and cash compensation modes never charge the same future grant twice, and payroll inclusion is explicit', () => {
  const f = fixture(), equity = build(f), cash = build(f, { compensationMode: 'cash' });
  assert.equal(equity.cases.base.years[0].annualCashSBC, 0);
  assert.equal(cash.cases.base.years[0].annualCashSBC, 200000000 * 1.06);
  assert.equal(cash.cases.base.years[0].netNewGrantDilution, 0);
  assert.equal(cash.cases.base.years[0].shares, cash.current.currentShares);
  assert.ok(equity.cases.base.years[0].shares > equity.current.currentShares);
  assert.equal(build(f, { opexIncludesSBCPayrollTax: true }).cases.base.years[0].annualPayrollTax, 0);
  assert.equal(build(f, { compensationMode: 'cash', annualSBCOverride: 0 }).cases.base.years[0].annualCashSBC, 0);
});
test('Higher growth increases economic value but also scales costs; higher investor hurdle reduces DCF', () => {
  const f = fixture(), original = build(f), growth = build(f, { scenarios: { base: { usdcGrowthStart: 0.40 } } });
  assert.ok(growth.cases.base.price > original.cases.base.price);
  assert.ok(growth.cases.base.years[0].annualAdjustedOpex > original.cases.base.years[0].annualAdjustedOpex);
  const highReturn = build(f, { scenarios: { base: { requiredReturn: 0.16 } } });
  assert.ok(highReturn.cases.base.methods.dcf.price < original.cases.base.methods.dcf.price);
});
test('Fast precomputed basis path equals the complete path and recomputes when corporate cash policy changes', () => {
  const f = fixture(), model = build(f), options = { asOf: '2026-10-01', dataAsOf: '2026-10-01', fundamentals: model.fundamentals, relativeBasis: model.relativeBasis };
  closeEnough(buildValuationV2(f.data, f.context, {}, options).cases.base.price, model.cases.base.price);
  const changed = buildValuationV2(f.data, f.context, { corporateUSDCUsability: 0 }, options);
  assert.equal(changed.relativeBasis.cashPolicy.corporateUSDCUsability, 0);
});
test('Four full-pricing reverse solves reproduce the market price and preserve current cash, shares and explicit overrides', () => {
  const f = fixture(), settings = { annualOtherRevenueOverride: 170000000, currentSharesOverride: 280000000, corporateNetCashOverride: 2500000000, relativeWeight: 0.5 };
  const model = build(f, settings);
  // Use a nearby target within the economic domain; this is an inverse identity,
  // not calibration of the defaults to the production stock quote.
  model.current.price = model.cases.base.price * 1.03;
  for (const variable of ['usdcGrowthStart', 'rateShift', 'retentionShiftEnd', 'requiredReturn']) {
    const inverse = reverseValuationV2(model, f.data, f.context, settings, variable);
    assert.equal(inverse.achievable, true, `${variable}: ${inverse.reason}`);
    closeEnough(inverse.reproducedPrice, model.current.price, 0.0001);
    assert.ok(inverse.iterations > 0 && inverse.iterations <= 60);
  }
});
test('Reverse cannot solve an unreachable market value by inventing zero or unbounded inputs', () => {
  const f = fixture(), model = build(f); model.current.price = 100000000;
  const inverse = reverseValuationV2(model, f.data, f.context, {}, 'requiredReturn');
  assert.equal(inverse.achievable, false); assert.equal(inverse.value, null);
  assert.match(inverse.reason, /不能/);
});
test('Missing source inputs or impossible economic parameters produce explicit unavailable research values', () => {
  assert.doesNotThrow(() => buildValuationV2(null, null, null));
  assert.equal(buildValuationV2(null).confidence.level, 'insufficient');
  const f = fixture(); delete f.context.capitalInputs;
  assert.equal(build(f).cases.base.price, null);
  const bad = build(fixture(), { scenarios: { base: { compensationGrowth: -2 } } });
  assert.equal(bad.cases.base.price, null);
  const overflow = build(fixture(), { scenarios: { base: { usdcGrowthStart: 1e308 } } });
  assert.equal(overflow.cases.base.price, null);
});
test('Capital version archive preserves the old pricing when a future disclosure replaces the compatibility alias', () => {
  const f = fixture(), initial = build(f);
  const old = structuredClone(f.context.capitalInputs), future = { ...old, availableAt: '2026-11-05', annualCashCapex: 200000000, annualDA: 200000000 };
  f.context.capitalInputSnapshots = [old, future];
  f.context.capitalInputs = future;
  const rebuilt = build(f);
  closeEnough(rebuilt.cases.base.price, initial.cases.base.price);
  assert.equal(rebuilt.capitalBasis.availableAt, '2026-08-05');
  assert.equal(rebuilt.capitalBasis.versionCount, 2);
});
test('Unverified capital or Fed sources cannot provide an actionable main pricing value', () => {
  const f = fixture(); f.context.capitalInputSnapshots = [{ ...f.context.capitalInputs, verified: false }];
  const unverified = build(f);
  assert.equal(unverified.cases.base.price, null);
  assert.ok(unverified.cases.base.diagnosticPrice > 0);
  assert.ok(unverified.dataBlockers.length > 0);
  assert.equal(unverified.confidence.level, 'insufficient');
  f.context.capitalInputSnapshots[0].verified = true;
  f.context.capitalInputSnapshots[0].sourceVerified = false;
  assert.equal(build(f).cases.base.price, null);
  const noURL = fixture(); noURL.context.capitalInputs.sourceUrls = ['not-a-source'];
  assert.equal(build(noURL).cases.base.price, null);
  const fed = fixture(); fed.context.fedSnapshots[0].sourceVerified = false;
  assert.equal(build(fed).cases.base.price, null);
  fed.context.fedSnapshots[0].sourceVerified = true; fed.context.fedSnapshots[0].sourceUrls = [];
  assert.equal(build(fed).cases.base.price, null);
});
test('Historical V1 is a separate literal with no dependency on current or V2 defaults', () => {
  assert.notEqual(HISTORICAL_SETTINGS_V1.scenarios, DEFAULT_SETTINGS.scenarios);
  assert.notEqual(HISTORICAL_SETTINGS_V1.scenarios.base, DEFAULT_SETTINGS.scenarios.base);
  assert.equal(HISTORICAL_SETTINGS_V1.scenarios.base.usdcGrowth, 0.15);
  assert.equal(HISTORICAL_SETTINGS_V1.scenarios.base.yieldShift, -0.006);
  assert.equal(V2_DEFAULTS.scenarios.base.usdcGrowthStart, 0.25);
  assert.equal(V2_DEFAULTS.scenarios.base.rateShift, 0);
  assert.equal(Object.isFrozen(HISTORICAL_SETTINGS_V1.scenarios.base), true);
});
