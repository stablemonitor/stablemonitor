/** Shared clocks: successful fetches do not make old observations current. */
export const MARKET_SOURCE_KEYS=Object.freeze(['CRCL','SPY','usdc','totalStablecoins','rates']);
export const MARKET_SOURCE_MAX_AGE_DAYS=Object.freeze({CRCL:5,SPY:5,usdc:4,totalStablecoins:4,rates:7});
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const array=value=>Array.isArray(value)?value:[];
export const validHealthDate=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value+'T00:00:00Z'))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
const timestamp=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)&&validHealthDate(value.slice(0,10))&&Number.isFinite(Date.parse(value));
const utcDay=value=>timestamp(value)?new Date(value).toISOString().slice(0,10):null;
const age=(first,last)=>validHealthDate(first)&&validHealthDate(last)?(Date.parse(last)-Date.parse(first))/86400000:null;
const lastDate=rows=>array(rows).filter(row=>validHealthDate(row?.date)).map(row=>row.date).sort().at(-1)??null;
const observedDate=(data,key)=>key==='CRCL'||key==='SPY'?lastDate(data?.prices?.[key]):key==='rates'?lastDate(data?.rates):lastDate(array(data?.usdc).filter(row=>finite(row?.[key==='usdc'?'usdc':'totalStablecoins'])&&row[key==='usdc'?'usdc':'totalStablecoins']>0));
const labels={CRCL:'CRCL 日线',SPY:'SPY 日线',usdc:'USDC 名义供给',totalStablecoins:'美元稳定币总量',rates:'SOFR'};
export function inspectMarketSources(data={},asOf=new Date().toISOString().slice(0,10)) {
  const rows=MARKET_SOURCE_KEYS.map(key=>{
    const source=record(data?.metadata?.sources?.[key])?data.metadata.sources[key]:null;
    const issues=[],actualAsOf=observedDate(data,key),limit=MARKET_SOURCE_MAX_AGE_DAYS[key];
    if(!validHealthDate(asOf))issues.push('当前评估日期无效');
    if(!source)issues.push('缺少'+key+'来源状态');
    else {
      if(source.status!=='fresh')issues.push(key+'来源状态'+(source.status||'缺失')+'，仅fresh允许行动');
      if(!validHealthDate(source.asOf))issues.push(key+'来源asOf日期无效');
      if(!timestamp(source.fetchedAt))issues.push(key+'来源fetchedAt时间无效');
      if(validHealthDate(source.asOf)&&utcDay(source.fetchedAt)&&source.asOf>utcDay(source.fetchedAt))issues.push(key+'来源日期晚于实际抓取时间');
      if(validHealthDate(source.asOf)&&validHealthDate(asOf)&&(source.asOf>asOf||age(source.asOf,asOf)>limit))issues.push(key+'来源日期超前或超过有效期');
      if(utcDay(source.fetchedAt)&&validHealthDate(asOf)&&utcDay(source.fetchedAt)>asOf)issues.push(key+'抓取时间晚于当前评估日');
      if(validHealthDate(source.asOf)&&source.asOf!==actualAsOf)issues.push(key+'来源asOf与实际最新观测不一致');
      if(source.status==='fresh'&&source.error)issues.push(key+'标记fresh但仍有来源错误');
    }
    const elapsed=age(source?.asOf,asOf),eligible=issues.length===0;
    const state=eligible?'valid':!source?'missing':elapsed!==null&&elapsed>limit?'expired':source.status==='cached'?'cached':source.status==='failed'?'failed':'inconsistent';
    return {key,label:labels[key],state,stateLabel:{valid:'日期与状态有效',missing:'来源缺失',expired:'观测已过期',cached:'缓存 · 更新失败',failed:'更新失败',inconsistent:'状态或日期异常'}[state],eligible,asOf:source?.asOf??null,actualAsOf,ageDays:elapsed,maximumAgeDays:limit,attemptedAt:source?.fetchedAt??null,lastSuccessfulAt:source?.lastSuccessfulFetchedAt??source?.cacheFetchedAt??(source?.status==='fresh'?source.fetchedAt:null),error:source?.error??null,url:source?.url??null,issues};
  });
  return {asOf,rows,passed:rows.filter(row=>row.eligible).length,total:rows.length,eligible:rows.every(row=>row.eligible),issues:rows.flatMap(row=>row.issues),generatedAt:data?.metadata?.generatedAt??null};
}
/** Arithmetic checks never imply that author assumptions are verified facts. */
export function buildEconomicChecks(snapshot={},data={}) {
  const f=snapshot?.fundamentals||{},v=snapshot?.valuationV2||{},base=v.cases?.base||{},current=v.current||{},dcf=base.methods?.dcf||{},relative=base.methods?.relative||{},checks=[];
  const add=(key,label,status,value,note)=>checks.push({key,label,status,value:finite(value)?value:null,note});
  const inputs=[f.totalRevenue,f.distributionAndTransactionCosts,f.otherCosts,f.rldc];
  const rldcDelta=inputs.every(finite)?inputs[0]-inputs[1]-inputs[2]-inputs[3]:null;
  add('rldc','财报 RLDC 勾稽',rldcDelta===null?'unknown':Math.abs(rldcDelta)<=1000?'pass':'review',rldcDelta,'总收入 − 分销交易成本 − 其他成本 − 披露RLDC；容许千美元舍入，核对会计字段而非预测。');
  const chain=array(data?.usdc).find(row=>row?.date===current.usdcAsOf);
  const total=finite(f.totalStablecoins)?f.totalStablecoins:chain?.totalStablecoins,usdcUSD=finite(f.currentUSDCUSD)?f.currentUSDCUSD:chain?.usdcUSD;
  add('share','市场份额同口径',!finite(usdcUSD)||!finite(total)?'unknown':usdcUSD>=0&&total>0&&usdcUSD<=total?'pass':'review',total>0&&finite(usdcUSD)?usdcUSD/total:null,'分子与分母均为同日美元锚定币USD市值；储备规模另用名义USDC，不混用脱锚价格。');
  const values=record(dcf.pvBridge)?Object.values(dcf.pvBridge):[];
  const pvDelta=values.length&&values.every(finite)&&finite(dcf.price)?values.reduce((sum,value)=>sum+value,0)-dcf.price:null;
  add('pv','每股现值勾稽',pvDelta===null?'unknown':Math.abs(pvDelta)<.000001?'pass':'review',pvDelta,'各现金流现值、终值与期初净现金合计减DCF；只确认算术一致。');
  const ratio=finite(dcf.price)&&dcf.price>0&&finite(relative.price)?relative.price/dcf.price:null;
  add('methods','两种方法分歧',ratio===null?'unknown':Math.abs(ratio-1)>.5?'assumption':'pass',ratio,'市场参照 / DCF；显著分歧需复核倍数、长期增长与回报要求，不能当两份独立证据。');
  add('terminal','DCF 对终值的依赖',finite(dcf.terminalShare)?'assumption':'unknown',dcf.terminalShare,'终值现值 / 经营现金流总现值，排除期初净现金；比例越高越依赖五年后的假设。');
  add('tax','成熟现金税率 · 假设',finite(v.settings?.taxRate)?'assumption':'unknown',v.settings?.taxRate,'成熟税率是研究输入，非最近季度有效税率或已缴现金税；首年税率 '+(finite(base.years?.[0]?.cashTaxRate)?(base.years[0].cashTaxRate*100).toFixed(2)+'%':'需补')+'，SBC抵税与亏损结转另需核验。');
  return checks;
}
