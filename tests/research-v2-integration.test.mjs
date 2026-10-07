import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as Research from '../assets/crcl-research-v2.js';
import {evaluateDecisions} from '../assets/crcl-decisions-v2.js';
import {explainDecision} from '../assets/crcl-usable.js';

// Healthy-behavior tests must not block the refresh that repairs a degraded live cache.
// This is an actual dated successful collection, never a live cache relabelled as fresh.
const fixture=JSON.parse(fs.readFileSync(new URL('./fixtures/crcl-v2-healthy-2026-10-02.json',import.meta.url)));
const expand=(rows,fields)=>rows.map(values=>Object.fromEntries(fields.map((field,index)=>[field,values[index]])));
const market={...fixture.market,
  prices:Object.fromEntries(Object.entries(fixture.market.prices).map(([ticker,rows])=>[ticker,expand(rows,fixture.market.tupleFields.prices)])),
  usdc:expand(fixture.market.usdc,fixture.market.tupleFields.usdc),
  rates:expand(fixture.market.rates,fixture.market.tupleFields.rates).map(row=>({...row,...fixture.market.rateProvenance}))
};
const data={...market,financials:fixture.financials,shares:fixture.shares,financialMetadata:fixture.financialMetadata,valuationContext:fixture.valuationContext};
const date=fixture.provenance.quoteDate;
const asOf=fixture.provenance.evaluationAsOf;
const options={latest:true,asOf,diagnostics:false};

test('Dated healthy reference retains real provenance and the history required by V2',()=>{
  assert.equal(fixture.provenance.marketCommit,'006e7e0');
  assert.equal(fixture.provenance.financialAndContextCommit,'014a8c7');
  assert.equal(market.metadata.generatedAt,fixture.provenance.fetchedAt);
  assert.equal(market.prices.CRCL.at(-1).date,date);
  assert.ok(market.prices.CRCL.length>200 && market.prices.SPY.length>200);
  for(const [key,source] of Object.entries(market.metadata.sources)) {
    assert.equal(source.status,'fresh');
    assert.deepEqual({url:source.url,asOf:source.asOf,fetchedAt:source.fetchedAt,status:source.status},fixture.provenance.sources[key]);
  }
  const reference=Research.evaluateSnapshot(data,date,{},options);
  assert.equal(reference.decisionV2.checklist.trial.find(row=>row.id==='data').pass,true);
  assert.deepEqual(reference.dataBlockers,[]);
});

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
test('Cached price sources veto decisions without being promoted by the healthy reference',()=>{
  const cached=structuredClone(data);
  for(const ticker of ['CRCL','SPY']) {
    cached.metadata.sources[ticker].status='cached';
    cached.metadata.sources[ticker].error=`${ticker} 2026-10-02 close: missing or non-numeric value`;
  }
  const result=Research.evaluateSnapshot(cached,date,{},options);
  assert.equal(result.decisionV2.checklist.trial.find(row=>row.id==='data').pass,false);
  assert.equal(result.buyGate,false);
  assert.equal(result.decisionV2.extremeGate,false);
  assert.ok(result.dataBlockers.some(reason=>reason.includes('cached')));
  assert.equal(cached.metadata.sources.CRCL.status,'cached');
  assert.equal(data.metadata.sources.CRCL.status,'fresh');
});
test('Budget defaults to independent severe stress, not narrower normal Bear',()=>{
  const latest=Research.evaluateSnapshot(data,date,{},options);
  const inputs={portfolioValue:100000,currentHoldingValue:0,availableCash:30000,maxWeight:.1,maxStressLoss:2000};
  const plan=Research.planAllocation(latest,inputs);
  assert.equal(plan.stressScenario,'severeStress');
  assert.ok(Math.abs(plan.lossRate-(1-latest.scenarios.severeStress.price/latest.price))<1e-7);
  assert.ok(plan.lossRate>1-latest.scenarios.bear.price/latest.price);
});
test('Held depeg exit review remains visible above add veto and budget messages',()=>{
  const depeg=Research.evaluateSnapshot(data,date,{depeg:true},options);
  assert.equal(depeg.decisionV2.exitGate,true);
  assert.match(explainDecision(depeg,'held').title,/退出复核/);
  assert.match(explainDecision(depeg,'flat').title,/暂停新增/);
  assert.match(explainDecision(depeg,'held',{configured:true,needReduceValue:10000}).title,/退出复核/);
  const high=Research.evaluateSnapshot(data,date,{eventRisk:'high'},options);
  assert.equal(high.decisionV2.exitGate,false);
  assert.match(explainDecision(high,'held').title,/暂停新增/);
  const stale=structuredClone(data);stale.metadata.sources.rates.status='cached';
  const invalid=Research.evaluateSnapshot(stale,date,{depeg:true},options);
  assert.match(explainDecision(invalid,'held',{configured:true,needReduceValue:10000}).title,/有效估值与数据/);
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
