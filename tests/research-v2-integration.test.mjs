import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as Research from '../assets/crcl-research-v2.js';
import {evaluateDecisions} from '../assets/crcl-decisions-v2.js';

const market=JSON.parse(fs.readFileSync(new URL('../data/market-data.json',import.meta.url)));
const financial=JSON.parse(fs.readFileSync(new URL('../data/financials.json',import.meta.url)));
const context=JSON.parse(fs.readFileSync(new URL('../data/valuation-context.json',import.meta.url)));
const data={...market,financials:financial.financials,shares:financial.shares,valuationContext:context};
const date=market.prices.CRCL.at(-1).date;
const asOf=new Date(Date.parse(date+'T00:00:00Z')+86400000).toISOString().slice(0,10);
const options={latest:true,asOf,diagnostics:false};

test('V2 public entrypoints preserve null and malformed data safety',()=>{
  const empty=Research.evaluateSnapshot(null,date,{},options);
  assert.equal(empty.buyGate,false);assert.ok(empty.dataBlockers.length);
  const malformed=structuredClone(data);malformed.prices.CRCL.push(null);
  const result=Research.evaluateSnapshot(malformed,date,{},options);
  assert.equal(result.buyGate,false);assert.ok(result.dataBlockers.length);
  assert.equal(Research.planAllocation(null,{}).configured,false);
  assert.equal(Research.planAllocation({},null).configured,false);
  assert.doesNotThrow(()=>Research.evaluateSnapshot({},date,null,null));
  assert.doesNotThrow(()=>Research.backtest(null,null,null));
});
test('V2 missing context never revives the old one-year trade anchor',()=>{
  const absent={...data,valuationContext:{}};
  const result=Research.evaluateSnapshot(absent,date,{},options);
  assert.equal(result.buyGate,false);assert.equal(result.priceMap.trial.price,null);
  assert.ok(result.dataBlockers.length);
});
test('All four displayed cent boundaries really satisfy their shared price gate',()=>{
  const latest=Research.evaluateSnapshot(data,date,{},options);
  for(const key of ['trial','core','trim','extreme']) {
    const map=latest.priceMap[key];
    assert.ok(Number.isFinite(map.price));
    assert.ok(Math.abs(map.price*100-Math.round(map.price*100))<1e-7);
    const at=evaluateDecisions({...latest,price:map.price});
    assert.equal(at[key+'Gate'],map.actionableAtPrice);
    const outward=evaluateDecisions({...latest,price:map.price+(['trial','core'].includes(key)?.01:-.01)});
    assert.equal(outward[key+'Gate'],false);
  }
});
test('Healthy fundamentals do not prevent valuation-based trim or high-premium review',()=>{
  const latest=Research.evaluateSnapshot(data,date,{},options);
  const high=evaluateDecisions({...latest,price:latest.priceMap.extreme.price*1.2});
  assert.equal(high.extremeGate,true);assert.equal(high.buyGate,false);
});
test('Actual source failures override plausible valuation prices and budgets',()=>{
  const stale=structuredClone(data);stale.metadata.sources.rates.status='cached';
  const result=Research.evaluateSnapshot(stale,date,{},options);
  assert.equal(result.buyGate,false);assert.ok(result.dataBlockers.length);
  const plan=Research.planAllocation(result,{portfolioValue:100000,currentHoldingValue:0,availableCash:30000,maxWeight:.1,maxStressLoss:2000});
  assert.equal(plan.actionableBuyValue,0);
});
test('Budget defaults to independent severe stress, not narrower normal Bear',()=>{
  const latest=Research.evaluateSnapshot(data,date,{},options);
  const inputs={portfolioValue:100000,currentHoldingValue:0,availableCash:30000,maxWeight:.1,maxStressLoss:2000};
  const plan=Research.planAllocation(latest,inputs);
  assert.equal(plan.stressScenario,'severeStress');
  assert.ok(Math.abs(plan.lossRate-(1-latest.scenarios.severeStress.price/latest.price))<1e-7);
  assert.ok(plan.lossRate>1-latest.scenarios.bear.price/latest.price);
});
test('Changed current research route updates all prices while frozen study history stays identical',()=>{
  const first=Research.analyze(data,{}, {asOf});
  const changed=Research.analyze(data,{relativeWeight:.75}, {asOf});
  assert.notEqual(first.latest.scenarios.base.price,changed.latest.scenarios.base.price);
  assert.deepEqual(first.history,changed.history);
  assert.deepEqual(first.backtest.equityCurve,changed.backtest.equityCurve);
});
test('V2 reconstruction and benchmarks start together with no additional funding',()=>{
  const result=Research.analyze(data,{}, {asOf});
  const curve=result.backtest.equityCurve;
  assert.ok(curve.length);
  assert.ok(curve.every(row=>Number.isFinite(row.strategy)&&Number.isFinite(row.buyAndHold)&&Number.isFinite(row.sameAllocationHold)&&Number.isFinite(row.scheduledDCA)));
  assert.ok(result.backtest.trades.every(t=>t.cash>=-1e-6&&t.position>=0&&t.date>t.signalDate));
});
