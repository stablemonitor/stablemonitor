import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {inspectMarketSources,buildEconomicChecks,MARKET_SOURCE_MAX_AGE_DAYS} from '../assets/crcl-data-health.js';
import {evaluateSnapshot} from '../assets/crcl-research-v2.js';
import {explainDecision} from '../assets/crcl-usable.js';
const sourceData=()=>({
  prices:{CRCL:[{date:'2026-10-06',close:84.13}],SPY:[{date:'2026-10-06',close:779.09}]},
  usdc:[{date:'2026-10-06',usdc:74e9,usdcUSD:74e9,totalStablecoins:312e9}],
  rates:[{date:'2026-10-06',sofr:.039}],
  metadata:{generatedAt:'2026-10-07T15:00:00Z',sources:Object.fromEntries(['CRCL','SPY','usdc','totalStablecoins','rates'].map(key=>[key,{status:'fresh',asOf:'2026-10-06',fetchedAt:'2026-10-07T15:00:00Z',lastSuccessfulFetchedAt:'2026-10-07T15:00:00Z'}]))}
});
test('Health labels assess observation age rather than the persistent fresh or generated stamp',()=>{
  const data=sourceData();
  assert.equal(inspectMarketSources(data,'2026-10-07').passed,5);
  data.metadata.generatedAt='2026-10-12T15:00:00Z';
  for(const source of Object.values(data.metadata.sources))source.fetchedAt='2026-10-12T15:00:00Z';
  const result=inspectMarketSources(data,'2026-10-12');
  assert.equal(result.eligible,false);
  assert.equal(result.rows.find(row=>row.key==='usdc').state,'expired');
  assert.equal(result.rows.find(row=>row.key==='CRCL').state,'expired');
});
test('Cached observations retain the last successful time independently of the last attempted time',()=>{
  const data=sourceData(),source=data.metadata.sources.CRCL;
  source.status='cached';source.fetchedAt='2026-10-08T15:00:00Z';source.error='partial close missing';
  const row=inspectMarketSources(data,'2026-10-08').rows[0];
  assert.equal(row.eligible,false);assert.equal(row.state,'cached');
  assert.equal(row.lastSuccessfulAt,'2026-10-07T15:00:00Z');
  assert.equal(row.attemptedAt,'2026-10-08T15:00:00Z');
});
test('SOFR age policy is shared with collection and rejects the eighth calendar day',()=>{
  assert.equal(MARKET_SOURCE_MAX_AGE_DAYS.rates,7);
  const data=sourceData();
  assert.equal(inspectMarketSources(data,'2026-10-13').rows.at(-1).eligible,true);
  assert.equal(inspectMarketSources(data,'2026-10-14').rows.at(-1).state,'expired');
});
test('Missing, mismatched and impossible source clocks never appear valid',()=>{
  assert.equal(inspectMarketSources(null,'2026-10-07').passed,0);
  assert.doesNotThrow(()=>inspectMarketSources({usdc:{}},'2026-10-07'));
  const data=sourceData();
  data.metadata.sources.CRCL.asOf='2026-10-05';
  data.metadata.sources.SPY.fetchedAt='2026-06-31T00:00:00Z';
  data.metadata.sources.rates.error='failed while incorrectly marked fresh';
  const result=inspectMarketSources(data,'2026-10-07');
  assert.equal(result.passed,2);
  assert.equal(inspectMarketSources(sourceData(),'2026-02-30').passed,0);
});
test('Arithmetic ledger detects RLDC, market-universe and PV errors without validating assumptions',()=>{
  const snapshot={fundamentals:{totalRevenue:100,distributionAndTransactionCosts:40,otherCosts:10,rldc:50,currentUSDCUSD:74,totalStablecoins:312},valuationV2:{settings:{taxRate:.21},cases:{base:{methods:{dcf:{price:30,pvBridge:{cash:10,terminal:20},terminalShare:.7},relative:{price:60}}}}}};
  const good=buildEconomicChecks(snapshot);
  assert.equal(good.find(row=>row.key==='rldc').status,'pass');
  assert.equal(good.find(row=>row.key==='pv').status,'pass');
  assert.equal(good.find(row=>row.key==='methods').status,'assumption');
  assert.equal(good.find(row=>row.key==='tax').status,'assumption');
  snapshot.fundamentals.rldc=100000;snapshot.fundamentals.currentUSDCUSD=400;
  snapshot.valuationV2.cases.base.methods.dcf.pvBridge.cash=11;
  for(const key of ['rldc','share','pv'])assert.equal(buildEconomicChecks(snapshot).find(row=>row.key===key).status,'review');
  assert.ok(buildEconomicChecks(null,null).every(row=>row.status==='unknown'));
});
test('V2 wrapper uses the current clock, rejects bad arithmetic and preserves trusted operating-loss review',()=>{
  const fixture=JSON.parse(fs.readFileSync(new URL('./fixtures/crcl-v2-healthy-2026-10-02.json',import.meta.url)));
  const expand=(rows,fields)=>rows.map(values=>Object.fromEntries(fields.map((key,index)=>[key,values[index]])));
  const data={...fixture.market,prices:Object.fromEntries(Object.entries(fixture.market.prices).map(([key,rows])=>[key,expand(rows,fixture.market.tupleFields.prices)])),usdc:expand(fixture.market.usdc,fixture.market.tupleFields.usdc),rates:expand(fixture.market.rates,fixture.market.tupleFields.rates),financials:fixture.financials,shares:fixture.shares,valuationContext:fixture.valuationContext};
  const result=evaluateSnapshot(data,fixture.provenance.quoteDate,{}, {latest:true,asOf:'2026-10-08',diagnostics:false});
  assert.equal(result.valuationV2.current.dataValidationAsOf,'2026-10-08');
  assert.equal(result.buyGate,false);assert.ok(result.dataBlockers.length);
  const broken=structuredClone(data);
  broken.financials.at(-1).rldc+=1000000;
  const bad=evaluateSnapshot(broken,fixture.provenance.quoteDate,{}, {latest:true,asOf:'2026-10-02',diagnostics:false});
  assert.ok(bad.dataBlockers.some(message=>message.includes('RLDC')));
  assert.equal(bad.buyGate,false);assert.equal(bad.sellGate,false);
  const loss=evaluateSnapshot(data,fixture.provenance.quoteDate,{compensationMode:'cash',annualSBCOverride:1500000000},{latest:true,asOf:'2026-10-02',diagnostics:false});
  assert.equal(loss.knownOperatingLoss,true);assert.equal(loss.scenarios.base.price,null);
  assert.equal(loss.dataBlockers.length,0);assert.equal(loss.exitGate,true);
  assert.equal(loss.buyGate,false);assert.equal(loss.priceMap.trial.price,null);
  assert.match(explainDecision(loss,'held').title,/退出复核/);
  assert.match(explainDecision(loss,'held').reason,/所选/);
  const sourceFailure=structuredClone(data);sourceFailure.metadata.sources.CRCL.status='cached';
  const untrusted=evaluateSnapshot(sourceFailure,fixture.provenance.quoteDate,{compensationMode:'cash',annualSBCOverride:1500000000},{latest:true,asOf:'2026-10-02',diagnostics:false});
  assert.equal(untrusted.exitGate,false);assert.ok(untrusted.dataBlockers.length);
  const noCapital=structuredClone(data);noCapital.valuationContext.capitalInputs.verified=false;
  for(const item of noCapital.valuationContext.capitalInputSnapshots||[])item.verified=false;
  const unknown=evaluateSnapshot(noCapital,fixture.provenance.quoteDate,{compensationMode:'cash',annualSBCOverride:1500000000},{latest:true,asOf:'2026-10-02',diagnostics:false});
  assert.equal(unknown.exitGate,false);assert.equal(unknown.knownOperatingLoss,false);
});
