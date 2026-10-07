import * as Legacy from './crcl-model.js?v=2.1.0';
import * as Valuation from './crcl-valuation-v2.js?v=2.1.0';
import * as Decisions from './crcl-decisions-v2.js?v=2.1.0';
import {buildEconomicChecks} from './crcl-data-health.js?v=2.1.0';

export const MODEL_VERSION='2.1.0-research';
export const HISTORICAL_FORMULA_VERSION='2.0.0-reconstructed-2026-10-02';
export const DEFAULT_SETTINGS=Object.freeze({
  ...Valuation.V2_DEFAULTS,...Decisions.DEFAULT_DECISION_SETTINGS,
  initialCash:100000,maxAllocation:.60,cooldownSessions:10,slippageBps:10,feeBps:5,
  opexIncludesSBCPayrollTax:false,budgetStressScenario:'severeStress'
});
const finite=n=>typeof n==='number'&&Number.isFinite(n);
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const clamp=(value,low,high)=>Math.max(low,Math.min(high,value));
const maps=new WeakMap();
const historyCache=new Map();
const clone=value=>structuredClone(value);
function config(overrides={}) {
  if(!record(overrides))overrides={};
  const result={...DEFAULT_SETTINGS,...overrides,scenarios:{}};
  for(const name of ['bear','base','bull','severeStress'])result.scenarios[name]={...DEFAULT_SETTINGS.scenarios[name],...(overrides.scenarios?.[name] || {})};
  result.initialCash=finite(result.initialCash)?Math.max(0,result.initialCash):DEFAULT_SETTINGS.initialCash;
  result.maxAllocation=finite(result.maxAllocation)?clamp(result.maxAllocation,0,1):DEFAULT_SETTINGS.maxAllocation;
  result.slippageBps=finite(result.slippageBps)?clamp(result.slippageBps,0,9999):DEFAULT_SETTINGS.slippageBps;
  result.feeBps=finite(result.feeBps)?clamp(result.feeBps,0,10000):DEFAULT_SETTINGS.feeBps;
  return result;
}
function contextOf(data){return data?.valuationContext || data?.researchContext || {};}
const mean=(bars,n)=>bars.length>=n?bars.slice(-n).reduce((s,b)=>s+b.close,0)/n:null;
function inputFor(data,date,options={}) {
  // Legacy is retained as a data/indicator validator. Its one-year valuation is
  // an audit comparator, never a veto or price anchor for the new strategy.
  const observed=Legacy.evaluateSnapshot(data,date,{}, {...options,diagnostics:false});
  const bars=(data.prices?.CRCL || []).filter(b=>b.date<=date && finite(b.close)).sort((a,b)=>a.date.localeCompare(b.date));
  observed.indicators={...observed.indicators,ma5:mean(bars,5),ma10:mean(bars,10)};
  const errors=(observed.dataBlockers || observed.blockers || []).filter(message=>!message.includes('关键模型输入缺失或超出经济边界'));
  return {...observed,rawProviderPrice:observed.price,price:finite(observed.price)?Math.round(observed.price*100)/100:null,dataBlockers:errors,blockers:errors,hardExit:false,legacyOneYearAudit:{formulaVersion:Legacy.MODEL_VERSION,price:observed.scenarios?.base?.price,scenarios:observed.scenarios,action:observed.action}};
}
function finalize(data,observed,settings,options={}) {
  const ctx=contextOf(data);
  const valuation=Valuation.buildValuationV2(data,ctx,settings,{asOf:observed.date,dataAsOf:options.asOf,fundamentals:observed.fundamentals});
  const snapshot={...observed,valuationV2:valuation,scenarios:valuation.cases || {},decisionSettings:settings,formulaVersion:MODEL_VERSION};
  const base=valuation.cases?.base;
  snapshot.knownOperatingLoss=Array.isArray(base?.years)&&base.years.length===5&&base.years.every(row=>finite(row.cashEBITDAProxy))&&finite(base.forwardCashEBITDAProxy)&&base.forwardCashEBITDAProxy<=0&&valuation.capitalBasis?.verified===true&&valuation.reserveRatePath?.valid===true&&!(valuation.dataBlockers||[]).length;
  if(!finite(base?.price)&&!snapshot.knownOperatingLoss)snapshot.dataBlockers=[...snapshot.dataBlockers,'V2估值输入或正常基准情景不足，暂停当前行动判断'];
  snapshot.economicChecks=buildEconomicChecks(snapshot,data);
  snapshot.dataBlockers=[...snapshot.dataBlockers,...snapshot.economicChecks.filter(check=>check.status==='review'&&['rldc','share','pv'].includes(check.key)).map(check=>'经济输入核对未通过：'+check.label)];
  const decision=Decisions.evaluateDecisions(snapshot,settings);
  snapshot.decisionV2=decision;
  snapshot.buyScore=decision.quality?.score ?? null;
  const premium=finite(valuation.cases?.base?.price)&&snapshot.price>0?snapshot.price/valuation.cases.base.price-1:null;
  snapshot.sellScore=finite(premium)?Math.max(0,Math.min(100,premium/Math.max(settings.extremePremium,.001)*100)):null;
  snapshot.buyComponents=decision.quality?.components || [];
  snapshot.sellComponents=[];
  snapshot.quality=decision.quality;snapshot.timing=decision.timing;
  snapshot.buyGate=decision.buyGate;snapshot.sellGate=decision.trimGate;
  snapshot.coreGate=decision.coreGate;snapshot.trialGate=decision.trialGate;
  snapshot.extremeGate=decision.extremeGate;snapshot.exitGate=decision.exitGate;
  snapshot.action=decision.action;snapshot.tier=decision.tier;
  snapshot.checklist=decision.checklist;snapshot.reasons=decision.reasons;
  snapshot.priceMap=decision.priceMap || Decisions.buildPriceMap(snapshot,settings);
  const p=snapshot.priceMap;
  snapshot.positionBands={buyBelow:p.trial?.price,addBelow:p.core?.price,trimAbove:p.trim?.price,bearReview:p.extreme?.price,
    trial:p.trial?.price,core:p.core?.price,trim:p.trim?.price,extreme:p.extreme?.price};
  snapshot.blockers=[...snapshot.dataBlockers,...(settings.depeg?['人工脱锚风险已开启']:settings.eventRisk==='high'?['人工事件风险已开启']:[])];
  snapshot.warnings=[...(observed.warnings || []).filter(x=>!x.includes('当前1.1公式')&&!x.includes('基础情景盈利或股权剩余')).map(x=>x.startsWith('corporateNetCash 采用保守政策')?'财报/V1净现金代理采用普通现金减债务与ARC预售；V2当前净现金另外按所选可用性折扣计公司自持USDC及已公开融资，实际桥见数据核对。':x),...(valuation.warnings || []),...(decision.quality?.warnings || [])];
  if(snapshot.knownOperatingLoss)snapshot.warnings.push('当前完整经营情景首年盈利非正，进入独立经营风险复核。'+(!finite(base?.price)?'正常研究中枢不适用，价线留空。':'可计算的远期价值不能取消首年经营风险。')+'这来自所选情景，不是来源缺数或已确认公司实亏。');
  snapshot.valuationContext=Legacy.valuationContext(observed,[],{});
  snapshot.modelComparison=valuation.cases?.base?.methods;
  if(options.latest && options.diagnostics!==false) {
    const variables=['usdcGrowthStart','rateShift','retentionShiftEnd','requiredReturn'];
    snapshot.reverseV2=Object.fromEntries(variables.map(variable=>[variable,Valuation.reverseValuationV2(valuation,data,ctx,settings,variable)]));
  }
  maps.set(snapshot.fundamentals,{data,ctx,date:observed.date,settings,valuation});
  return snapshot;
}
export function evaluateSnapshot(data,date,overrides={},options={}) {
  if(!record(options))options={};
  data=normalizeData(data);
  const settings=config(overrides);
  const observed=inputFor(data,date,options);
  return finalize(data,observed,settings,options);
}
export function calculateScenario(f,assumption,overrides={}) {
  const entry=maps.get(f);
  if(!entry)return {price:null,invalid:true,invalidReason:'本次估值没有对应数据快照'};
  const settings=config(overrides);
  settings.scenarios.base={...settings.scenarios.base,...assumption};
  return Valuation.buildValuationV2(entry.data,entry.ctx,settings,{asOf:entry.date,fundamentals:f,relativeBasis:entry.valuation.relativeBasis}).cases.base;
}
export function planAllocation(snapshot,inputs={}) {
  if(!record(snapshot))snapshot={};
  if(!record(inputs))inputs={};
  // Existing budget checks are reused; signal and tranche are supplied by V2.
  const stressKey=snapshot.decisionSettings?.budgetStressScenario || 'severeStress';
  const adapted={...snapshot,scenarios:{...snapshot.scenarios,bear:snapshot.valuationV2?.cases?.[stressKey] || snapshot.scenarios?.bear},hardExit:snapshot.decisionV2?.exitGate===true,buyGate:snapshot.decisionV2?.buyGate===true};
  const result=Legacy.planAllocation(adapted,inputs);
  const fraction=snapshot.decisionV2?.trancheFraction ?? 0;
  const limit=result.configured && finite(inputs.portfolioValue)?inputs.portfolioValue*fraction:0;
  result.actionableBuyValue=Math.min(result.actionableBuyValue || 0,limit);
  result.trancheCap=limit;result.trancheFraction=fraction;
  result.stressScenario=stressKey;
  result.warnings=[...(result.warnings || []),'单次额度还受V2试仓/核心分批步速约束；指标不是胜率。'];
  return result;
}
function buildResearchHistory(data,settings) {
  const frozen=config();
  // The current sliders never alter the authored V2 reconstruction defaults.
  const observed=Legacy.buildHistory(data);
  const bars=Legacy.normalizeData(data).prices.CRCL;
  const rows=[];let lastMarker=-Infinity,lastTier=null;
  for(let index=0;index<observed.length;index++) {
    const original=observed[index];
    const old={...original,rawProviderPrice:original.price,price:finite(original.price)?Math.round(original.price*100)/100:null,indicators:{...original.indicators,ma5:mean(bars.slice(0,index+1),5),ma10:mean(bars.slice(0,index+1),10)}};
    const item=finalize(data,{...old,dataBlockers:[...(old.dataBlockers || [])].filter(s=>!s.includes('关键模型输入缺失或超出经济边界')),hardExit:false,legacyOneYearAudit:{formulaVersion:old.formulaVersion,price:old.scenarios?.base?.price}},frozen,{diagnostics:false});
    item.marker=null;
    const active=item.buyGate||item.sellGate||item.exitGate||item.extremeGate;
    if(active&&(index-lastMarker>=frozen.cooldownSessions || item.tier!==lastTier)) {
      item.marker={type:item.buyGate?'buy':item.exitGate||item.extremeGate?'exit':'sell',label:item.action,tier:item.tier,score:item.buyGate?item.buyScore:item.sellScore,trancheFraction:item.decisionV2.trancheFraction};
      lastMarker=index;
    }
    rows.push({...item,bearPrice:item.scenarios.bear?.price??null,basePrice:item.scenarios.base?.price??null,bullPrice:item.scenarios.bull?.price??null});
    lastTier=item.tier;
  }
  return rows;
}
export function backtest(data,history,overrides={}) {
  data=normalizeData(data);if(!Array.isArray(history))history=[];
  const settings=config(overrides);
  const original=Legacy.backtest(data,history.map(row=>({...row,buyScore:finite(row.scenarios.base?.price)&&!row.dataBlockers?.length?row.buyScore:null,hardExit:false,marker:null})),settings);
  const bars=(data.prices?.CRCL || []).filter(row=>finite(row.close)).sort((a,b)=>a.date.localeCompare(b.date));
  const begin=history.findIndex(row=>finite(row.buyScore)&&!row.dataBlockers?.length&&finite(row.scenarios.base?.price));
  if(begin<0)return original;
  let cash=settings.initialCash,shares=0,cost=0,peak=cash,drawdown=0;
  const curve=[],trades=[],closed=[];
  for(let index=begin+1;index<bars.length;index++) {
    const bar=bars[index],signal=history[index-1],marker=signal?.marker;
    if(finite(bar.open)&&bar.open>0&&marker) {
      const equity=cash+shares*bar.open;
      if(marker.type==='buy') {
        const fill=bar.open*(1+settings.slippageBps/10000),funds=Math.max(0,Math.min(cash,equity*marker.trancheFraction,equity*settings.maxAllocation-shares*bar.open));
        const quantity=funds/(fill*(1+settings.feeBps/10000)),fee=quantity*fill*settings.feeBps/10000;
        if(quantity>0){cash-=quantity*fill+fee;shares+=quantity;cost+=quantity*fill+fee;trades.push({signalDate:signal.date,date:bar.date,side:'buy',tier:marker.tier,quantity,price:fill,fee,cash,position:shares});}
      } else if(shares>0) {
        const fill=bar.open*(1-settings.slippageBps/10000),quantity=marker.type==='exit'?shares:Math.min(shares,equity*settings.trimTrancheFraction/bar.open),fee=quantity*fill*settings.feeBps/10000,basis=cost*(quantity/shares),proceeds=quantity*fill-fee;
        cash+=proceeds;shares-=quantity;cost-=basis;closed.push(proceeds-basis);trades.push({signalDate:signal.date,date:bar.date,side:'sell',tier:marker.tier,quantity,price:fill,fee,cash,position:shares});
      }
    }
    const strategy=cash+shares*bar.close;peak=Math.max(peak,strategy);if(peak>0)drawdown=Math.min(drawdown,strategy/peak-1);
    const old=original.equityCurve.find(row=>row.date===bar.date) || {};
    curve.push({...old,date:bar.date,strategy,exposure:strategy>0?shares*bar.close/strategy:0,cash,position:shares});
  }
  return {...original,strategy:{totalReturn:settings.initialCash>0?(curve.at(-1)?.strategy ?? settings.initialCash)/settings.initialCash-1:null,maxDrawdown:drawdown,trades:trades.length,averageExposure:curve.length?curve.reduce((s,row)=>s+row.exposure,0)/curve.length:null,endingEquity:curve.at(-1)?.strategy ?? settings.initialCash},equityCurve:curve,trades,
    coverage:{...original.coverage,actualTrades:trades.length,buyEpisodes:history.filter((row,i)=>row.buyGate&&!history[i-1]?.buyGate).length,winRate:closed.length?closed.filter(n=>n>0).length/closed.length:null,active:trades.length>0,status:trades.length?'active':'inactive',closedTradeEvents:closed.length,historyFormulaVersion:HISTORICAL_FORMULA_VERSION},
    limitations:[...(original.limitations || []),'V2规则和情景编写于2026-10-02，历史仅作当时数据重建，未按收益择优参数；风险复核在回放中假定次日清仓，实际需人工复核。']};
}
export function analyze(data,overrides={},options={}) {
  if(!record(options))options={};
  data=normalizeData(data);
  const settings=config(overrides),lastDate=(data.prices?.CRCL || []).at(-1)?.date;
  const key=JSON.stringify({prices:data.prices,usdc:data.usdc,rates:data.rates,financials:data.financials,shares:data.shares,context:contextOf(data)});
  let history=historyCache.get(key);
  if(!history){history=buildResearchHistory(data);if(historyCache.size>=1)historyCache.clear();historyCache.set(key,history);}
  const latest=evaluateSnapshot(data,lastDate,settings,{latest:true,asOf:options.asOf || new Date().toISOString().slice(0,10)});
  const archive=Legacy.analyze(data,{},options);
  return {modelVersion:MODEL_VERSION,historyFormulaVersion:HISTORICAL_FORMULA_VERSION,settings,latest,history,backtest:backtest(data,history,settings),archive:{history:archive.history,backtest:archive.backtest,formulaVersion:Legacy.HISTORICAL_FORMULA_VERSION},metadata:data.metadata,dataErrors:latest.dataErrors || [],limitations:['主图为V2研究规则重建；旧版V1归档另行保留。','DCF、相对估值共享经营输入，方法数不代表独立证据数；情景不是置信区间。','试仓与核心分批路线独立于旧总分门槛；技术主要控制速度，估值过高可独立触发减仓。']};
}
export function normalizeData(data) {const normalized=Legacy.normalizeData(data);normalized.valuationContext=contextOf(data);return normalized;}
export const calculateIndicators=Legacy.calculateIndicators;
export const StableModel={MODEL_VERSION,DEFAULT_SETTINGS,analyze,evaluateSnapshot,calculateScenario,planAllocation,backtest,normalizeData,calculateIndicators};
