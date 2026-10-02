import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateDecisions, decisionChecklist, buildPriceMap, deriveQuality } from '../assets/crcl-decisions-v2.js';

function fixture(price = 80) {
  return {
    date: '2026-09-30', price, dataBlockers: [], blockers: [],
    indicators: { usdc30d: 0.06, usdc90d: 0.16, marketShare90d: 0.01,
      ma5: 79, ma10: 78, ma20: 78, ma60: 75, rsi14: 48, atr14: 3 },
    fundamentals: { reserveRetention: 0.45, adjustedEBITDA: 140e6,
      otherRevenue: 40e6, quarterAdjustedOpex: 80e6,
      previousFinancial: { reserveRetention: 0.44, adjustedEBITDA: 120e6, otherRevenue: 30e6, quarterAdjustedOpex: 75e6 } },
    valuationV2: { confidence: { level: 'medium' }, cases: {
      bear: { price: 80 }, base: { price: 100, forwardCashEBITDAProxy: 160e6,
        forwardFCFF: 120e6, methods: { dcf: { price: 75 }, relative: { price: 125 } } },
      bull: { price: 130 }, severeStress: { price: 10 }
    } }
  };
}

test('Healthy discounted equity can enter core without a second composite score gate', () => {
  const result = evaluateDecisions({ ...fixture(80), buyScore: 5, sellScore: 90 });
  assert.equal(result.coreGate, true);
  assert.equal(result.tier, 'core');
  assert.equal(result.buyGate, true);
  assert.equal(result.trancheFraction, 0.15);
});

test('Trial and core have distinct required upside and tranche sizes', () => {
  const trial = evaluateDecisions(fixture(93));
  assert.equal(trial.trialGate, true);
  assert.equal(trial.coreGate, false);
  assert.equal(trial.tier, 'trial');
  assert.equal(trial.trancheFraction, 0.05);
  assert.equal(evaluateDecisions(fixture(98)).buyGate, false);
});

test('Healthy expensive equity can trim without an RSI or legacy sell-score veto', () => {
  const result = evaluateDecisions({ ...fixture(120), sellScore: 10 });
  assert.equal(result.trimGate, true);
  assert.equal(result.tier, 'trim');
  assert.equal(result.trancheFraction, 0.15);
});

test('Extreme premium is an independent review trigger for any sufficiently high price', () => {
  for (const price of [135, 150, 1000, 1e6]) {
    const result = evaluateDecisions(fixture(price));
    assert.equal(result.extremeGate, true);
    assert.equal(result.tier, 'extreme');
    assert.equal(result.buyGate, false);
    assert.equal(result.fullReview, true);
  }
});

test('Bad data or missing quality never generates a new position', () => {
  const badData = fixture(70); badData.dataBlockers = ['USDC feed expired'];
  assert.equal(evaluateDecisions(badData).buyGate, false);
  assert.equal(evaluateDecisions(badData).tier, 'data-blocked');
  const incomplete = fixture(70); incomplete.indicators.usdc90d = null;
  assert.equal(deriveQuality(incomplete).complete, false);
  assert.equal(evaluateDecisions(incomplete).buyGate, false);
});

test('Quality is independent of price, RSI and correlated technical measures', () => {
  const first = fixture(80), second = fixture(800);
  second.indicators.rsi14 = 99; second.indicators.ma20 = 1; second.indicators.atr14 = 300;
  assert.deepEqual(deriveQuality(first), deriveQuality(second));
  const quality = deriveQuality(first);
  assert.ok(quality.score >= 0 && quality.score <= 100);
  assert.equal(quality.components.reduce((sum, item) => sum + item.max, 0), 100);
});

test('Annual recurring-revenue guidance is not substituted for missing quarterly evidence', () => {
  const data = fixture(70);
  delete data.fundamentals.otherRevenue;
  data.fundamentals.annualRecurringOtherRevenue = 200e6;
  assert.equal(deriveQuality(data).complete, false);
  assert.equal(evaluateDecisions(data).buyGate, false);
});

test('Downtrend delays trial but only slows a fundamental core allocation', () => {
  const weak = fixture(93);
  Object.assign(weak.indicators, { ma5: 96, ma10: 97, ma20: 100, ma60: 105 });
  const trial = evaluateDecisions(weak);
  assert.equal(trial.timing.downtrend, true);
  assert.equal(trial.timing.stabilized, false);
  assert.equal(trial.trialGate, false);
  weak.price = 80;
  const core = evaluateDecisions(weak);
  assert.equal(core.coreGate, true);
  assert.equal(core.tier, 'core');
  assert.equal(core.speedBudget, 0.5);
  assert.equal(core.trancheFraction, 0.075);
});

test('Reclaiming both short averages permits trial despite a lagging long trend', () => {
  const recovered = fixture(93);
  Object.assign(recovered.indicators, { ma5: 91, ma10: 92, ma20: 100, ma60: 105 });
  assert.equal(evaluateDecisions(recovered).trialGate, true);
});

test('Missing short averages cannot fabricate stabilization inside a downtrend', () => {
  const data = fixture(93);
  Object.assign(data.indicators, { ma5: null, ma10: null, ma20: 100, ma60: 105 });
  assert.equal(evaluateDecisions(data).trialGate, false);
  assert.ok(evaluateDecisions(data).checklist.trial.some(row => !row.pass && row.id === 'timing'));
});

test('A price map is conditional on frozen observed timing, not a future RSI prediction', () => {
  const data = fixture(82);
  Object.assign(data.indicators, { ma5: 85, ma10: 86, ma20: 90, ma60: 95 });
  const map = buildPriceMap(data);
  assert.equal(map.trial.price, 95.23);
  assert.equal(map.trial.nonPricePass, false);
  assert.equal(map.trial.actionableAtPrice, false);
  assert.ok(map.trial.nonPriceBlockers.some(text => text.includes('企稳')));
  assert.equal(map.core.nonPricePass, true);
  assert.equal(map.core.actionableAtPrice, true);
  assert.equal(map.timingPolicy, 'observed-indicators-frozen');
});

test('Displayed boundaries and evaluation gates agree exactly and around each boundary', () => {
  const source = fixture();
  const settings = { targetUpsideTrial: 0.1, targetUpsideCore: 0.3, trimPremium: 0.2, extremePremium: 0.5 };
  const map = buildPriceMap(source, settings);
  const gates = { trial: 'trialGate', core: 'coreGate', trim: 'trimGate', extreme: 'extremeGate' };
  for (const [key, gate] of Object.entries(gates)) {
    const price = map[key].price;
    const at = evaluateDecisions({ ...source, observedPrice: source.price, price }, settings);
    assert.equal(at[gate], true);
    const outside = ['trial', 'core'].includes(key) ? price + 0.01 : price - 0.01;
    assert.equal(evaluateDecisions({ ...source, observedPrice: source.price, price: outside }, settings)[gate], false);
  }
});

test('Event risk and depeg forbid buying even at an exceptionally cheap price', () => {
  assert.equal(evaluateDecisions(fixture(10), { eventRisk: 'high' }).buyGate, false);
  assert.equal(evaluateDecisions(fixture(10), { depeg: true }).buyGate, false);
});

test('Known operating losses trigger review; capex-related negative FCFF does not', () => {
  const currentLoss = fixture(70); currentLoss.fundamentals.adjustedEBITDA = -1;
  assert.equal(evaluateDecisions(currentLoss).exitGate, true);
  assert.equal(evaluateDecisions(currentLoss).buyGate, false);
  const forecastLoss = fixture(70); forecastLoss.valuationV2.cases.base.forwardCashEBITDAProxy = -1;
  assert.equal(evaluateDecisions(forecastLoss).exitGate, true);
  const investing = fixture(70); investing.valuationV2.cases.base.forwardFCFF = -1;
  assert.equal(evaluateDecisions(investing).exitGate, false);
  assert.equal(evaluateDecisions(investing).coreGate, true);
});

test('Joint stress never replaces normal Bear or the normal pricing center', () => {
  const data = fixture(80); data.valuationV2.cases.severeStress.price = 1;
  const map = buildPriceMap(data);
  assert.equal(map.core.price, 83.33);
  assert.equal(map.normalBear, 80);
  assert.equal(map.stressPrice, 1);
  assert.equal(map.strictDCF.price, 75 / 1.2);
  assert.equal(evaluateDecisions(data).coreGate, true);
});

test('Unavailable v2 pricing stays blank instead of silently restoring a legacy price', () => {
  const data = fixture(70); data.valuationV2.cases.base.price = null;
  data.scenarios = { base: { price: 100 } };
  assert.equal(buildPriceMap(data).trial.price, null);
  assert.equal(evaluateDecisions(data).buyGate, false);
});

test('Checklist is the actual gating source and a configuration error is visible', () => {
  const source = fixture(80), result = evaluateDecisions(source);
  assert.deepEqual(decisionChecklist(source), result.checklist);
  assert.equal(result.coreGate, result.checklist.core.every(row => row.pass));
  const invalid = evaluateDecisions(source, { targetUpsideTrial: 0.3, targetUpsideCore: 0.1 });
  assert.equal(invalid.buyGate, false);
  assert.ok(invalid.configurationBlockers.length);
});

test('Decisions and price maps do not mutate observed inputs or inherited settings', () => {
  const source = fixture(80);
  source.decisionSettings = { targetUpsideCore: 0.25, eventRisk: 'normal' };
  const original = structuredClone(source);
  evaluateDecisions(source);
  buildPriceMap(source);
  assert.deepEqual(source, original);
  assert.equal(buildPriceMap(source).core.price, 80);
});

test('Nonfinite prices and malformed missing observations degrade safely', () => {
  const source = fixture(Infinity);
  assert.equal(evaluateDecisions(source).buyGate, false);
  assert.equal(evaluateDecisions(source).tier, 'data-blocked');
  assert.equal(evaluateDecisions(null).buyGate, false);
  assert.equal(deriveQuality({ fundamentals: { annualRecurringOtherRevenue: 1e9 } }).score, null);
});

test('Severe economic deterioration is separate from merely low quality', () => {
  const source = fixture(70);
  source.indicators.usdc30d = -0.07;
  source.indicators.usdc90d = -0.13;
  const result = evaluateDecisions(source);
  assert.equal(result.exitGate, true);
  assert.equal(result.tier, 'exit-review');
  assert.equal(result.buyGate, false);
});

test('Current fractional-center counterexamples use conservative cent thresholds in both map and gates', () => {
  const source = fixture(82);
  source.valuationV2.cases.base.price = 74.56659;
  const map = buildPriceMap(source);
  assert.deepEqual(['trial', 'core', 'trim', 'extreme'].map(key => map[key].price), [71.01, 62.13, 85.76, 100.67]);
  assert.equal(map.roundingPolicy.tick, 0.01);
  assert.equal(map.roundingPolicy.buyUpper, 'floor');
  assert.equal(map.roundingPolicy.sellLower, 'ceil');
  const gates = { trial: 'trialGate', core: 'coreGate', trim: 'trimGate', extreme: 'extremeGate' };
  for (const [key, gate] of Object.entries(gates)) {
    const price = map[key].price;
    const at = evaluateDecisions({ ...source, observedPrice: source.price, price });
    assert.equal(at[gate], true, `${key} displayed quote must satisfy its gate`);
    assert.equal(map[key].actionableAtPrice, true);
    const outside = ['trial', 'core'].includes(key) ? price + 0.01 : price - 0.01;
    const inside = ['trial', 'core'].includes(key) ? price - 0.01 : price + 0.01;
    assert.equal(evaluateDecisions({ ...source, observedPrice: source.price, price: outside })[gate], false);
    assert.equal(evaluateDecisions({ ...source, observedPrice: source.price, price: inside })[gate], true);
  }
  assert.ok(source.valuationV2.cases.base.price / map.trial.price - 1 >= 0.05);
  assert.ok(source.valuationV2.cases.base.price / map.core.price - 1 >= 0.20);
  assert.ok(map.trim.price / source.valuationV2.cases.base.price - 1 >= 0.15);
  assert.ok(map.extreme.price / source.valuationV2.cases.base.price - 1 >= 0.35);
});

test('Cent-aligned mathematical boundaries do not lose an extra cent to floating point', () => {
  const source = fixture(80);
  source.valuationV2.cases.base.price = 71.01 * 1.05;
  assert.equal(buildPriceMap(source).trial.price, 71.01);
  const price = buildPriceMap(source).trial.price;
  assert.equal(evaluateDecisions({ ...source, observedPrice: source.price, price: price + 1e-10 }).trialGate, true);
});
