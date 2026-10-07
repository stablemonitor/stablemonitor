import * as Model from './crcl-research-v2.js?v=2.1.0';
import {renderResearch,buildPortfolioForm,readPortfolioForm,fillPortfolioForm} from './crcl-usable.js?v=2.1.0';
import {inspectMarketSources,buildEconomicChecks} from './crcl-data-health.js?v=2.1.0';

const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const finite = n => typeof n === 'number' && Number.isFinite(n);
const money = n => finite(n) ? `$${n.toLocaleString('en-US', {minimumFractionDigits:2,maximumFractionDigits:2})}` : '需补';
const number = (n, places = 1) => finite(n) ? n.toLocaleString('en-US', {maximumFractionDigits:places,minimumFractionDigits:places}) : '需补';
const pct = (n, places = 1, sign = false) => finite(n) ? `${sign && n > 0 ? '+' : ''}${number(n*100, places)}%` : '需补';
const dollars = n => finite(n) ? Math.abs(n) >= 1e9 ? `$${number(n/1e9,2)}B` : `$${number(n/1e6,1)}M` : '需补';
const displayDate = value => {
  if (!value) return '需补';
  if (!String(value).includes('T')) return String(value).slice(0,10);
  const parsed=new Date(value);
  if (!Number.isFinite(parsed.getTime())) return '需补';
  const parts=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(parsed).map(p=>[p.type,p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
};
const defaultSettings = structuredClone(Model.DEFAULT_SETTINGS);
let settings = structuredClone(defaultSettings);
let data, analysis, visibleHistory = [], range = '180', selectedIndex = -1;
let researchState={positionView:'flat',portfolio:null,demo:false};
const scenarioLimits={usdcGrowthStart:[-.9,1.5],usdcGrowthEnd:[-.5,.8],rateShift:[-.025,.025],retentionShiftEnd:[-.2,.2],otherGrowthStart:[-.5,1.5],otherGrowthEnd:[-.3,.8],opexGrowth:[-.2,.5],compensationGrowth:[-.2,.5],newGrantDilution:[0,.15],requiredReturn:[.07,.25],terminalGrowth:[0,.05],capexGrowth:[-.2,.5]};
function linkScenarioField(key,baseValue) {
  const shift=baseValue-settings.scenarios.base[key],limits=scenarioLimits[key],clipped=[];
  for (const name of ['bear','base','bull']) {
    const value=settings.scenarios[name][key]+shift;
    const bounded=Math.max(limits[0],Math.min(limits[1],value));
    if (bounded!==value) clipped.push(name);
    settings.scenarios[name][key]=bounded;
  }
  if (clipped.length) $('settings-feedback').textContent=`${clipped.join(' / ')} 的 ${fields.find(f=>f.key===key)?.label || '联动参数'} 已按经济边界约束；请在完整计算表查看实际假设。`;
}

function table(headers, rows) {
  return `<thead><tr>${headers.map(x => `<th scope="col">${esc(x)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map((x,i) => `<${i ? 'td' : 'th'}${i ? '' : ' scope="row"'}>${esc(x)}</${i ? 'td' : 'th'}>`).join('')}</tr>`).join('')}</tbody>`;
}
function setStatus(message, error = false) {
  $('loading-status').hidden = false;
  $('loading-status').textContent = message;
  $('loading-status').classList.toggle('error',error);
}
const beijingStamp=value=>{
  const parsed=new Date(value);
  return value&&Number.isFinite(parsed.getTime())?new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(parsed):'未记录';
};
function renderDataHealth() {
  const l=analysis.latest||{},v=l.valuationV2||{},c=v.current||{},f=l.fundamentals||{},health=inspectMarketSources(data,new Date().toISOString().slice(0,10));
  const blocked=!!l.dataBlockers?.length;
  $('data-health-summary').textContent=(blocked?'暂停当前行动 · ':'')+health.passed+'/'+health.total+'个市场来源日期与状态有效。观测日、成功采集与最近尝试分别记录；更新成功不代表经济假设已被验证。'+(blocked&&health.eligible?' 暂停原因：'+l.dataBlockers[0]:'');
  $('data-health-summary').classList.toggle('warning',blocked);
  const clocks=[
    ['价格研究时点',displayDate(l.date),'已结束美股日线，盘中报价不进入本次判断'],
    ['本次供给 / SOFR输入','USDC '+displayDate(c.usdcAsOf)+'\nSOFR '+displayDate(c.rateAsOf),'为'+displayDate(l.date)+'收盘研究滞后一日取值；来源最新日期另列'],
    ['财报原始实绩',f.period||'需补','期末 '+displayDate(f.financialPeriodEnd)+' · 披露 '+displayDate(f.financialAvailableAt)],
    ['宏观 / 资本输入版本','SEP '+displayDate(v.reserveRatePath?.sourceAvailableAt)+'\n资本 '+displayDate(v.capitalBasis?.availableAt),'SEP委员判断与资本年化代理；版本日期不等于每日观测']
  ];
  $('input-clock').innerHTML=clocks.map(([label,value,note])=>'<article class="health-clock"><span>'+esc(label)+'</span><strong>'+esc(value)+'</strong><p>'+esc(note)+'</p></article>').join('');
  $('source-health-table').innerHTML='<table>'+table(['来源','观测日 / 允许滞后','最近成功 · 北京时间','最近尝试 · 北京时间','当前状态'],health.rows.map(row=>[row.label,displayDate(row.asOf)+' / '+row.maximumAgeDays+'自然日',beijingStamp(row.lastSuccessfulAt),beijingStamp(row.attemptedAt),row.stateLabel+(row.error?'；'+row.error:row.issues.length?'；'+row.issues.join('；'):'')]))+'</table>';
  const checks=buildEconomicChecks(l,data);
  const checkValue=check=>!finite(check.value)?'需补':check.key==='share'||check.key==='terminal'||check.key==='tax'?pct(check.value,2):check.key==='methods'?number(check.value,2)+'×':check.key==='pv'?money(check.value):dollars(check.value);
  $('economic-checks').innerHTML=checks.map(check=>'<article class="audit-check"><div><span>'+esc(check.label)+'</span><b class="health-state '+check.status+'">'+esc({pass:'算术核对',assumption:'研究假设',review:'需复核',unknown:'资料不足'}[check.status])+'</b></div><strong>'+esc(checkValue(check))+'</strong><p>'+esc(check.note)+'</p></article>').join('');
  const financing=(c.includedEvents||[]).filter(event=>event.cashIncluded).reduce((sum,event)=>sum+(event.cashDelta||0),0);
  $('current-capital-bridge').textContent='本次净现金 '+dollars(c.corporateNetCash)+'：普通公司现金 '+dollars(c.ordinaryCash)+' − 债务 '+dollars(c.corporateDebt)+' − ARC预售 '+dollars(c.arcPresaleCashExcluded)+' ＋ 公司自持USDC '+dollars(c.corporateUSDC)+' × '+pct(c.corporateUSDCUsability,0)+' ＋ 已完成公开融资 '+dollars(financing)+'。客户储备不计公司净现金。'+(settings.corporateNetCashOverride!==null?'当前已启用手动净现金覆盖，上述原始桥用于复核。':'')+' 本次权益代理 '+number(c.currentShares/1e6,3)+'M；原财报加权稀释代理 '+number(f.dilutedShares/1e6,3)+'M，已公开融资新增股数单独纳入，仍不等于精确fully diluted spot股数。';
  const terms=(data.valuationContext?.commercialTerms||[]).filter(item=>item.verified&&item.availableAt<l.date);
  $('commercial-terms-note').textContent=terms.length?terms.map(item=>'已知商业条款（'+displayDate(item.availableAt)+'）：'+item.summary).join('；'):'渠道合同费率和未来留存改善仍需人工核验，融资金额不能代替分销费用。';
}
function renderDecision() {
  const l = analysis.latest;
  const dataBlocked=!!l?.dataBlockers?.length;
  const marketBlocked=!inspectMarketSources(data,new Date().toISOString().slice(0,10)).eligible;
  $('quote-price').textContent = money(l?.price);
  $('quote-date').textContent = `美东交易日 ${displayDate(l?.date)} · 排除未完成日线`;
  $('decision-title').textContent = l?.action || '等待数据';
  const buy = finite(l?.buyScore) ? Math.round(l.buyScore) : '—';
  const sell = finite(l?.sellScore) ? Math.round(l.sellScore) : '—';
  $('buy-score').textContent = buy;
  $('sell-score').textContent = sell;
  $('buy-meter').style.width = `${finite(l?.buyScore) ? Math.max(0,Math.min(100,l.buyScore)) : 0}%`;
  $('sell-meter').style.width = `${finite(l?.sellScore) ? Math.max(0,Math.min(100,l.sellScore)) : 0}%`;
  const signalExplanation=l?.blockers?.length ? l.blockers.slice(0,2).join('；') : `${l?.reasons?.[0] || '当前条件需要综合判断'}；买入 ${finite(l?.buyScore)?number(l.buyScore,1):'—'}/100，减仓 ${finite(l?.sellScore)?number(l.sellScore,1):'—'}/100，须同时满足估值与风险门槛。`;
  $('decision-reason').textContent = signalExplanation;
  const tags = [
    {text:JSON.stringify(settings)===JSON.stringify(defaultSettings)?'基准假设':'当前自定义假设 · 历史保持基准'},
    {text:`财报 ${displayDate(l?.fundamentals?.financialPeriodEnd)}`},
    {text:`USDC ${displayDate(l?.fundamentals?.usdcAsOf)}`},
    {text:`利率 ${displayDate(l?.fundamentals?.rateAsOf)}`},
    ...(dataBlocked?[{text:'数据限制 · 详见下方核对',danger:true}]:((l?.blockers || []).map(text=>({text,danger:true}))))
  ];
  $('decision-tags').innerHTML = tags.map(t => `<span class="tag${t.danger ? ' danger' : ''}">${esc(t.text)}</span>`).join('');
  $('risk-notice').textContent = dataBlocked?'当前行动已暂停。以下价格和估值仅为截至 '+displayDate(l.date)+(marketBlocked?' 的缓存研究参考。':' 的条件研究参考；估值或经济输入需复核。')+'完整异常见数据核对及条件清单。':l?.blockers?.length?l.blockers.join(' · '):'正常经营情景与联合压力分开。价格条件需与基本面、行情和预算一起核对；两种估值方法的分歧完整列示。';
  $('risk-notice').classList.toggle('warning', !!l?.blockers?.length);
  const s = l?.scenarios || {};
  const b = l?.positionBands || {};
  const names={trial:'小仓试探条件',core:'核心分批条件',trim:'估值减仓条件',extreme:'高溢价复核条件'};
  $('position-bands').innerHTML=['trial','core','trim','extreme'].map(key=>{
    const p=l.priceMap?.[key] || {};
    const economicUnavailable=l.knownOperatingLoss&&!finite(p.price);
    const status=economicUnavailable?'经营风险 · 估值不适用':dataBlocked?(marketBlocked?'缓存参考 · 暂停行动':'条件不足 · 暂停行动'):p.priceConditionPass?'价格已到':'价格未到';
    const note=economicUnavailable?'所选情景经营亏损，价线留空；先复核费用及薪酬假设。':dataBlocked?'截至 '+displayDate(l.date)+(marketBlocked?'。来源恢复前不作为当前行动线。':'。估值或经济输入不足，详见核对。'):(p.condition||'新估值不足，条件留空')+(p.nonPricePass?'':'；还需：'+(p.nonPriceBlockers||[]).slice(0,2).join('；'));
    return '<article class="level-card '+(['trial','core'].includes(key)?'buy':'sell')+'"><span class="level-title">'+names[key]+' · '+status+'</span><strong>'+(economicUnavailable?'不适用':money(p.price))+'</strong><p>'+esc(note)+'</p></article>';
  }).join('');
  $('score-components').innerHTML = [['基本面质量（不含价格）',l?.buyComponents,'buy'],['溢价压力（非旧65分门槛）',l?.sellComponents,'sell']].map(([name,components,cls])=>`<div class="component-column ${cls}"><h3>${name}</h3>${components?.length ? components.map(c=>`<div class="component-row"><span>${esc(c.label)}</span><strong>${number(c.value,1)} / ${c.max}</strong><div class="meter ${cls==='sell'?'sell':''}"><i style="width:${Math.max(0,Math.min(100,c.value/c.max*100))}%"></i></div></div>`).join('') : `<p class="muted">${l?.decisionV2?'减仓直接按研究中枢溢价和风险规则判断，无需基本面先恶化。':l?.hardExit?'盈利非正，估值倍数不适用，暂停总分。':'关键数据不足，暂停评分。'}</p>`}</div>`).join('');
}

function renderScenarios() {
  const l = analysis.latest;
  const cases = l?.scenarios || {};
  const labels = {bear:'Bear · 正常下行情景',base:'Base · 多期经营基准',bull:'Bull · 有条件的增长情景'};
  const notes = {bear:'增长恢复较慢、费率承压；不是所有参数同时最坏。',base:'按SEP路径、五年规模及现金流，不再默认降息60bp。',bull:'增长与留存改善，也计扩张费用和新增权益。'};
  $('scenario-cards').innerHTML = ['bear','base','bull'].map(key => {
    const s = cases[key] || {};
    const upside = finite(s.price) && finite(l?.price) ? s.price/l.price-1 : null;
    const unpriced = !finite(s.price);
    const economicUnavailable=unpriced&&l.knownOperatingLoss;
    return `<article class="scenario-card ${key}${unpriced?' unpriced':''}"><h3>${labels[key]}</h3><div class="scenario-price">${economicUnavailable?'不适用':money(s.price)}</div><p class="scenario-upside">${economicUnavailable?'所选经营情景亏损，估值留空':'相对收盘 '+pct(upside,1,true)}</p><p>${notes[key]}</p><dl><dt>DCF</dt><dd>${money(s.methods?.dcf?.price)}</dd><dt>相对定价</dt><dd>${money(s.methods?.relative?.price)}</dd><dt>首年平均 USDC</dt><dd>${dollars(s.averageUSDC)}</dd><dt>首年现金经营</dt><dd>${dollars(s.cashEBITDAProxy ?? s.forwardEBITDA)}</dd></dl></article>`;
  }).join('');
  const valuation=l.valuationV2 || {},base=cases.base || {},stress=cases.severeStress || {};
  $('valuation-audit').textContent=`旧一年倍数模型：${money(l.legacyOneYearAudit?.price)}，现在只作审计参照。Base五年DCF ${money(base.methods?.dcf?.price)}、历史TTM定价参照 ${money(base.methods?.relative?.price)}；中枢权重DCF ${pct(1-settings.relativeWeight,0)} / 相对 ${pct(settings.relativeWeight,0)}。联合压力 ${money(stress.price)} 单列，不充当正常Bear。${valuation.confidence?.reasons?.join('；') || ''}`;
  $('projection-table').innerHTML=table(['年度区间','期末USDC','期间均值','储备yield','留存储备','平台贡献','现金经营','现金税','再投资','企业营运增量','现金税率','SBC税基扣除','应税利润代理','净现金流','权益代理','每股现金流'],(base.years || []).map(y=>[`${y.startDate} → ${y.endDate}`,dollars(y.endUSDC),dollars(y.averageUSDC),pct(y.reserveYield,2),dollars(y.netReserveIncome),dollars(y.otherContribution),dollars(y.cashEBITDAProxy),dollars(y.cashTaxes),dollars(y.cashCapex),dollars(y.deltaNWC),pct(y.cashTaxRate,2),dollars(y.eligibleSBCTaxDeduction),dollars(y.taxableIncomeProxy),dollars(y.fcff),`${number(y.shares/1e6,1)}M`,money(y.cfPerShare)]));
  $('pv-bridge').innerHTML=Object.entries(base.methods?.dcf?.pvBridge || {}).filter(([key])=>key!=='limitedLiabilityFloor').map(([key,value])=>`<article class="research-metric"><span>${{reserve:'储备每股现值',platform:'平台每股现值',costs:'现金费用每股现值',taxes:'现金税每股现值',capex:'再投每股现值',nwc:'营运资金每股现值',terminal:'终值每股现值',netCash:'公司净现金每股'}[key] || key}</span><strong>${money(value)}</strong></article>`).join('');
  const metrics = [
    ['首年 USDC 增长假设','assumptions',a => pct(a?.usdcGrowthStart,1,true)],['第5年 USDC 增长','assumptions',a => pct(a?.usdcGrowthEnd,1,true)],['利率路径偏移','assumptions',a => finite(a?.rateShift)?`${number(a.rateShift*10000,0)}bp`:'需补'],['股东回报要求','assumptions',a=>pct(a?.requiredReturn)],
    ['平均 USDC','averageUSDC',dollars],['储备收益率','reserveYield',pct],['储备收入留存','reserveRetention',pct],
    ['经常性其他收入 / 年','annualRecurringOtherRevenue',dollars],['调整后经营费用 / 年','annualAdjustedOpex',dollars],
    ['首年现金工资税代理','years',years=>dollars(years?.[0]?.annualPayrollTax)],['首年现金薪酬替代','years',years=>dollars(years?.[0]?.annualCashSBC)],
    ['首年经营利润代理','forwardEBITDA',dollars],['企业净现金','corporateNetCash',dollars],
    ['未来资本承诺','futureCapitalCommitments',dollars],['首年权益代理','dilutedShares',n => finite(n) ? `${number(n/1e6,1)}M` : '需补'],['当日研究中枢','price',money]
  ];
  $('scenario-table').innerHTML = table(['计算项','Bear','Base','Bull'], metrics.map(([label,key,fmt]) => [label,...['bear','base','bull'].map(k => {
    const c=cases[k];
    return ['price','enterpriseValue','equityValue'].includes(key)&&finite(c?.forwardEBITDA)&&c.forwardEBITDA<=0?'不适用（盈利非正）':fmt(c?.[key]);
  })]));
  renderSensitivity();
}

const fields = [
  {
    "key": "usdcGrowthStart",
    "label": "首年USDC期末增长",
    "unit": "%",
    "factor": 100,
    "min": -90,
    "max": 150,
    "note": "期间平均=(年初+年末)/2，后续逐年放缓",
    "step": "any"
  },
  {
    "key": "usdcGrowthEnd",
    "label": "第5年USDC增长",
    "unit": "%",
    "factor": 100,
    "min": -50,
    "max": 80,
    "note": "与首年形成五年路径，不把周期40%当每年承诺",
    "step": "any"
  },
  {
    "key": "rateShift",
    "label": "SEP储备利率路径偏移",
    "unit": "bp",
    "factor": 10000,
    "min": -250,
    "max": 250,
    "note": "Base默认0，按最新年末FF路径积分成年均",
    "step": "any"
  },
  {
    "key": "retentionShiftEnd",
    "label": "第5年留存率变化",
    "unit": "pp",
    "factor": 100,
    "min": -20,
    "max": 20,
    "note": "逐步走向该变动；渠道费率没有完整披露",
    "step": "any"
  },
  {
    "key": "otherGrowthStart",
    "label": "首年经常性other增长",
    "unit": "%",
    "factor": 100,
    "min": -50,
    "max": 150,
    "note": "以历史指引代理为起点，预售不直接年化",
    "step": "any"
  },
  {
    "key": "otherGrowthEnd",
    "label": "第5年other增长",
    "unit": "%",
    "factor": 100,
    "min": -30,
    "max": 80,
    "note": "平台收入路径，未公开Arc或CPN收费率不造收入",
    "step": "any"
  },
  {
    "key": "opexGrowth",
    "label": "首年调整费用增长",
    "unit": "%",
    "factor": 100,
    "min": -20,
    "max": 50,
    "note": "后续按规模弹性修正，现金工资税单独算",
    "step": "any"
  },
  {
    "key": "compensationGrowth",
    "label": "现金工资税／薪酬增长",
    "unit": "%",
    "factor": 100,
    "min": -20,
    "max": 50,
    "note": "薪酬路径独立于费用，不再永远固定季度年化",
    "step": "any"
  },
  {
    "key": "newGrantDilution",
    "label": "每年新增经济权益",
    "unit": "%",
    "factor": 100,
    "min": 0,
    "max": 15,
    "note": "不把既有RSU归属重复当新增；现金替代时不叠加",
    "step": "any"
  },
  {
    "key": "requiredReturn",
    "label": "DCF要求股东回报",
    "unit": "%",
    "factor": 100,
    "min": 7,
    "max": 25,
    "note": "作者风险回报要求，非精确估计WACC",
    "step": "any"
  },
  {
    "key": "terminalGrowth",
    "label": "公司终值现金流增长",
    "unit": "%",
    "factor": 100,
    "min": 0,
    "max": 5,
    "note": "每股终值增长还需扣持续稀释，必须低于回报要求",
    "step": "any"
  },
  {
    "key": "capexGrowth",
    "label": "现金再投资增长",
    "unit": "%",
    "factor": 100,
    "min": -20,
    "max": 50,
    "note": "现金开发／CapEx，不能把客户储备投入当企业资本开支",
    "step": "any"
  },
  {
    "key": "corporateUSDCUsability",
    "label": "公司自持USDC可用比例",
    "unit": "%",
    "factor": 100,
    "min": 0,
    "max": 100,
    "global": true,
    "note": "公司资产可纳入可用比例；客户储备始终排除",
    "step": "any"
  },
  {
    "key": "taxRate",
    "label": "归一化现金税率",
    "unit": "%",
    "factor": 100,
    "min": 0,
    "max": 40,
    "global": true,
    "note": "税盾和地区差异未完全重建，21%是研究假设",
    "step": "any"
  },
  {
    "key": "nwcRate",
    "label": "新增企业收入的营运资金",
    "unit": "%",
    "factor": 100,
    "min": 0,
    "max": 30,
    "global": true,
    "note": "作用于净经营收入增量，不作用于客户USDC储备",
    "step": "any"
  },
  {
    "key": "annualOpexOverride",
    "label": "当前年调整费用覆盖",
    "unit": "$M",
    "factor": 0.000001,
    "min": 100,
    "max": 2000,
    "global": true,
    "note": "默认已公布577.5M指引代理，再推未来五年",
    "step": "any"
  },
  {
    "key": "annualOtherRevenueOverride",
    "label": "当前年经常性other覆盖",
    "unit": "$M",
    "factor": 0.000001,
    "min": 0,
    "max": 1500,
    "global": true,
    "note": "留空160M历史指引代理，不把ARC预售当ARR",
    "step": "any"
  },
  {
    "key": "currentSharesOverride",
    "label": "当前权益代理覆盖",
    "unit": "M",
    "factor": 0.000001,
    "min": 100,
    "max": 1000,
    "global": true,
    "note": "默认已披露稀释代理＋未反映的已完成融资股份",
    "step": "any"
  },
  {
    "key": "annualPayrollTaxOverride",
    "label": "当前年现金工资税覆盖",
    "unit": "$M",
    "factor": 0.000001,
    "min": 0,
    "max": 200,
    "global": true,
    "note": "默认4×已披露季度工资税，随后按薪酬增长",
    "step": "any"
  },
  {
    "key": "annualSBCOverride",
    "label": "当前年现金薪酬替代覆盖",
    "unit": "$M",
    "factor": 0.000001,
    "min": 0,
    "max": 1500,
    "global": true,
    "note": "现金模式扣费用，不再同份额外稀释",
    "step": "any"
  },
  {
    "key": "annualCashCapexOverride",
    "label": "当前年现金再投资覆盖",
    "unit": "$M",
    "factor": 0.000001,
    "min": 0,
    "max": 1000,
    "global": true,
    "note": "默认现金软件35.8M＋长期资产10.4M半年额×2代理",
    "step": "any"
  },
  {
    "key": "relativeMultipleOverride",
    "label": "相对定价倍数覆盖",
    "unit": "x",
    "factor": 1,
    "min": 5,
    "max": 80,
    "global": true,
    "note": "留空取已知TTM自身历史分位，非纯peer中位数",
    "step": "any"
  },
  {
    "key": "targetUpsideTrial",
    "label": "试仓要求中枢回报",
    "unit": "%",
    "factor": 100,
    "min": 0,
    "max": 50,
    "global": true,
    "note": "试仓价=研究中枢/(1+要求回报)，不再另AND高总分",
    "step": "any"
  },
  {
    "key": "targetUpsideCore",
    "label": "核心分批要求回报",
    "unit": "%",
    "factor": 100,
    "min": 0,
    "max": 100,
    "global": true,
    "note": "不能低于试仓要求；技术下行主要降低步速",
    "step": "any"
  },
  {
    "key": "trimPremium",
    "label": "分批减仓溢价门槛",
    "unit": "%",
    "factor": 100,
    "min": 0,
    "max": 100,
    "global": true,
    "note": "超过中枢该比例即可独立减仓，不必基本面先坏",
    "step": "any"
  },
  {
    "key": "extremePremium",
    "label": "高溢价复核门槛",
    "unit": "%",
    "factor": 100,
    "min": 0,
    "max": 200,
    "global": true,
    "note": "不得低于减仓门槛，复核不等于自动全卖",
    "step": "any"
  }
];
fields.push(
  {key:'initialCashTaxRate',label:'首年现金税率 · 可选',unit:'%',factor:100,min:0,max:50,global:true,note:'留空跟随成熟税率；低税率须有SBC/NOL依据，不把季度退款永久外推',step:'any'},
  {key:'cashTaxConvergenceYears',label:'现金税率收敛年数',unit:'年',factor:1,min:2,max:5,global:true,note:'从首年税率线性收敛至成熟税率；稳态第6年使用成熟值',step:1},
  {key:'equitySbcTaxDeductionRatio',label:'权益SBC可抵税比例 · 假设',unit:'%',factor:100,min:0,max:100,global:true,note:'默认0%；只减税基，现金替代不重复减；不是已核实税法扣除额',step:'any'}
);
function buildSettings() {
  const fieldMarkup=f=>`<div class="setting"><label for="input-${f.key}">${f.label}</label><div class="setting-input"><input type="number" id="input-${f.key}" name="${f.key}" min="${f.min}" max="${f.max}" step="${f.step || 'any'}" inputmode="decimal" aria-describedby="note-${f.key}"><span class="unit">${f.unit}</span></div><small id="note-${f.key}">${f.note}</small></div>`;
  $('settings-form').innerHTML=fields.filter(f=>!f.global).map(fieldMarkup).join('')+'<details class="details advanced-settings"><summary>资本、税与行动门槛：展开高级参数</summary><div class="settings-grid">'+fields.filter(f=>f.global).map(fieldMarkup).join('')+'</div></details>';
  syncSettings();
  $('settings-form').addEventListener('submit', e => e.preventDefault());
  $('settings-form').addEventListener('change', event => {
    const f = fields.find(f => f.key === event.target.name);
    if (!f) return;
    const input = event.target;
    if (input.value === '' && f.global) settings[f.key] = defaultSettings[f.key]===null?null:defaultSettings[f.key];
    else {
      if (input.value === '' || !input.checkValidity()) { input.reportValidity(); syncSettings(); return; }
      const value = Number(input.value) / f.factor;
      if (f.global) settings[f.key] = value;
      else {
        linkScenarioField(f.key,value);
      }
    }
    recalculate();
  });
}
function syncSettings() {
  for (const f of fields) {
    const value = f.global ? settings[f.key] : settings.scenarios.base[f.key];
    $(`input-${f.key}`).value = finite(value) ? Math.round(value*f.factor*10000)/10000 : '';
    if (f.global) {
      const fundamentals = analysis?.latest?.fundamentals || {};
      const v=analysis.latest.valuationV2;
      const automatic={initialCashTaxRate:settings.taxRate,annualOpexOverride:fundamentals.annualAdjustedOpex,annualOtherRevenueOverride:fundamentals.annualRecurringOtherRevenue,currentSharesOverride:v?.current?.currentShares,annualPayrollTaxOverride:4*(fundamentals.sbcPayrollTaxes??fundamentals.SBCPayrollTaxes),annualSBCOverride:4*fundamentals.stockBasedCompensationExpense,annualCashCapexOverride:data.valuationContext?.capitalInputs?.annualCashCapex,relativeMultipleOverride:v?.relativeBasis?.multiples?.base}[f.key];
      $(`input-${f.key}`).placeholder = finite(automatic) ? number(automatic*f.factor,2) : '需补';
    }
  }
  $('event-risk').value = settings.eventRisk;
  $('depeg-risk').checked = settings.depeg;
  $('valuation-method').value = settings.relativeWeight===0?'intrinsic':settings.relativeWeight===.75?'growth':'balanced';
  $('compensation-mode').value = settings.compensationMode || 'equity';
  $('opex-includes-payroll').checked = !!settings.opexIncludesSBCPayrollTax;
  $('include-pending-deals').checked=!!settings.includePendingDeals;
  $('input-newGrantDilution').disabled = settings.compensationMode==='cash';
  $('input-annualSBCOverride').disabled = settings.compensationMode!=='cash' && !settings.equitySbcTaxDeductionRatio;
  $('input-equitySbcTaxDeductionRatio').disabled = settings.compensationMode==='cash';
  $('settings-form').querySelector('label[for="input-annualSBCOverride"]').textContent=settings.compensationMode==='cash'?'当前年现金替代SBC支出':'当前年权益SBC税基代理';
  $('note-annualSBCOverride').textContent=settings.compensationMode==='cash'?'现金替代模式扣经营费用，取消同份新增权益稀释；不重复扣税基。':'仅按所选比例扣税基，不扣同份现金经营费用；额外可抵税部分减少现金税，不是已核实税额。';
  $('input-annualPayrollTaxOverride').disabled = !!settings.opexIncludesSBCPayrollTax;
}
function renderSensitivity() {
  const f=analysis.latest?.fundamentals;if(!f)return;
  const center=settings.scenarios.base;
  const returns=[...new Set([-.02,-.01,0,.01,.02].map(delta=>Math.max(.07,Math.min(.25,center.requiredReturn+delta))))];
  const growths=[...new Set([-.10,-.05,0,.05,.10].map(delta=>Math.max(-.9,Math.min(1.5,center.usdcGrowthStart+delta))))];
  $('sensitivity-table').innerHTML='<thead><tr><th>首年USDC / 回报要求</th>'+returns.map(r=>'<th>'+pct(r)+'</th>').join('')+'</tr></thead><tbody>'+growths.map(g=>'<tr><th>'+pct(g,0,true)+'</th>'+returns.map(r=>{
    const c=Model.calculateScenario(f,{...center,usdcGrowthStart:g,requiredReturn:r},settings),v=c?.price,current=Math.abs(g-center.usdcGrowthStart)<1e-9&&Math.abs(r-center.requiredReturn)<1e-9;
    return '<td><button data-growth="'+g+'" data-return="'+r+'" class="'+(current?'current-cell':'')+'" aria-pressed="'+current+'" '+(finite(v)?'':'disabled')+' aria-label="首年规模'+pct(g)+'，回报要求'+pct(r)+'，研究中枢'+money(v)+'">'+money(v)+'</button></td>';
  }).join('')+'</tr>').join('')+'</tbody>';
}

function renderIndicators() {
  const l = analysis.latest || {}, i = l.indicators || {}, f = l.fundamentals || {}, s = l.scenarios || {}, c=l.valuationV2?.current || {};
  const rows = [
    ['USDC 估值起点 · 观测',dollars(c.currentUSDC),'模型使用 '+displayDate(c.usdcAsOf)+' 名义余额；未来平均规模另作假设'],
    ['USDC · 7 / 30 日',`${pct(i.usdc7d,1,true)} / ${pct(i.usdc30d,1,true)}`,'按期初规模计算净变化，缺失留空'],
    ['USDC · 90 日',pct(i.usdc90d,1,true),'绝对增长与竞争份额共同观察'],
    ['USDC 市占 / 90 日变化',`${pct(i.marketShare)} / ${finite(i.marketShare90d)?`${number(i.marketShare90d*100,2)}pp`:'需补'}`,'美元稳定币全市场口径'],
    ['当前储备收益率 · 代理',pct(c.reserveYield,2),'报告yield与同季SOFR校准，加入 '+displayDate(c.rateAsOf)+' 短端利率；非实时储备实测'],
    ['储备收入留存',pct(f.reserveRetention,2),'储备收入扣分销交易成本后的留存'],
    ['RLDC 利润率',pct(f.rldcMargin,2),'全部收入扣全部相关成本，不等于储备留存'],
    ['渠道分销成本占比',pct(f.distributionRatio,2),'全部分销及交易成本，不全部归因 Coinbase'],
    ['经常性其他收入 · 假设',dollars(settings.annualOtherRevenueOverride ?? f.annualRecurringOtherRevenue),'历史全年指引中点代理；未单列真实经常性金额'],
    ['年调整后经营费用 · 假设',dollars(settings.annualOpexOverride ?? f.annualAdjustedOpex),'已知全年指引中点；未来增长另行假设'],
    ['本次模型权益代理',finite(c.currentShares)?number(c.currentShares/1e6,3)+'M':'需补','原财报 '+number(f.dilutedShares/1e6,3)+'M，加已公开融资；仍非精确fully diluted股数'],
    ['本次企业净现金',dollars(c.corporateNetCash),'含公司自持USDC可用性折扣与完成融资；客户储备和ARC排除，详情见数据核对'],
    ['Base 估值安全边际',pct(finite(s.base?.price) && s.base.price>0 ? 1-l.price/s.base.price : null,1,true),'1 − 当前价格 / Base 情景价值'],
    ['RSI · Wilder 14',number(i.rsi14,1),'低于 30 常见超卖；不单独决定买入'],
    ['MA60 / MA200',`${money(i.ma60)} / ${money(i.ma200)}`,'趋势参考；不足窗口留空'],
    ['ATR14 / 20 日年化波动',`${money(i.atr14)} / ${pct(i.rv20)}`,'衡量交易波动和分批风险'],
    ['距历史高点 / 相对 SPY 20 日',`${pct(i.drawdown,1,true)} / ${pct(i.relativeReturn20d,1,true)}`,'回撤不是估值；相对强弱辅助趋势判断'],
    ['最新季收入 · 实绩',dollars(f.totalRevenue),'总收入含渠道分成，不能直接当股东收入'],
    ['最新季 RLDC · 实绩',dollars(f.rldc),'全部收入减分销、交易及其他相关成本'],
    ['最新季调整 EBITDA · 实绩',dollars(f.adjustedEBITDA),'非GAAP；与模拟 EBITDA 不完全同口径'],
    ['最新季储备收益率 · 实绩',pct(f.reportedReserveYield,2),'报告实际值；当前校准代理另行列示']
  ];
  $('indicator-grid').innerHTML = rows.map(([label,value,note]) => `<article class="indicator-card"><div class="indicator-label">${label}</div><div class="indicator-value">${esc(value)}</div><p class="indicator-note">${esc(note)}</p></article>`).join('');
}
function renderBacktest() {
  const b = analysis.backtest || {}, strategy = b.strategy || {}, benchmark = b.buyAndHold || {};
  const stats = [
    ['纪律组合总回报',pct(strategy.totalReturn,1,true),`买入持有 ${pct(benchmark.totalReturn,1,true)}`],
    ['纪律组合最大回撤',pct(strategy.maxDrawdown,1,true),`买入持有 ${pct(benchmark.maxDrawdown,1,true)}`],
    ['实际执行次数',finite(strategy.trades)?String(strategy.trades):'需补',`平均仓位 ${pct(strategy.averageExposure)}`],
    ['期末组合价值',dollars(strategy.endingEquity),`初始现金 ${dollars(settings.initialCash)}`]
  ];
  $('backtest-grid').innerHTML = stats.map(([label,value,note]) => `<div class="backtest-stat"><label>${esc(label)}</label><strong>${esc(value)}</strong><small>${esc(note)}</small></div>`).join('');
  const curve = b.equityCurve || [];
  const markerCounts = (analysis.history || []).reduce((counts,row)=>{ if (row.marker) counts[row.marker.type]=(counts[row.marker.type] || 0)+1;return counts; },{});
  const zeroEntry = !b.trades?.some(t=>t.side==='buy') ? '当前基准规则未入场；0%回报仅代表一直持有现金，不能证明择时或收益有效。' : '';
  $('backtest-details').innerHTML = `${zeroEntry ? `<p class="replay-warning">${zeroEntry}</p>` : ''}<p>${esc(`${displayDate(curve[0]?.date)} — ${displayDate(curve.at(-1)?.date)}。历史标记：买入候选 ${markerCounts.buy || 0} 次，减仓候选 ${markerCounts.sell || 0} 次，退出复核 ${markerCounts.exit || 0} 次；标记不等于成交。初始现金 $100,000；新增配置上限 ${pct(defaultSettings.maxAllocation,0)}，单次配置 ${pct(defaultSettings.trancheFraction,0)}；滑点 ${defaultSettings.slippageBps}bp + 手续费 ${defaultSettings.feeBps}bp。持有对照投入全部初始现金，因此比较同时反映择时与仓位差异。历史回放使用固定初始研究规则，不随当前情景输入变动。${(b.limitations || []).join(' ')}`)}</p>`;
  const trades = (b.trades || []).slice(-12).reverse();
  $('trades-table').innerHTML = table(['信号收盘日','执行开盘日','动作','执行价','股数','手续费','剩余现金'], trades.length ? trades.map(t => [t.signalDate,t.date,t.side === 'buy' ? '买入' : '卖出',money(t.price),number(t.quantity,2),money(t.fee),money(t.cash)]) : [['尚无执行记录','—','—','—','—','—','—']]);
}
function renderSources() {
  renderDataHealth();
  const sourceHealth=new Map(inspectMarketSources(data,new Date().toISOString().slice(0,10)).rows.map(row=>[row.key,row]));
  const sources = data.metadata?.sources || {};
  const titles = {prices:'日线价格 · Yahoo Finance',CRCL:'CRCL 日线 · Yahoo Finance',SPY:'SPY 日线 · Yahoo Finance',usdc:'USDC · DefiLlama',totalStablecoins:'美元稳定币总量 · DefiLlama',rates:'短端利率 · 纽约联储 SOFR',financials:'季度财报 · Circle / SEC'};
  const items = Object.entries(sources).map(([key,source]) => {
    const url = /^https:\/\//.test(source.url || '') ? source.url : null;
    const status = source.status || '需补';
    const effective=sourceHealth.get(key);
    const ok=effective?effective.eligible:['ok','verified','fresh'].includes(status);
    const statusLabel=effective?effective.stateLabel:{fresh:'已更新',verified:'原文核实',cached:'缓存 · 更新失败',failed:'更新失败',ok:'已更新'}[status] || status;
    return `<div class="source-item"><div><strong>${url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(titles[key] || key)} ↗</a>` : esc(titles[key] || key)}</strong><p>数据截至 ${displayDate(source.asOf)} · 采集 ${displayDate(source.fetchedAt || data.metadata?.generatedAt)}</p>${source.error ? `<p>${esc(source.error)}</p>` : ''}</div><span class="source-state${ok ? '' : ' warn'}">${esc(statusLabel)}</span></div>`;
  });
  const f = analysis.latest?.fundamentals || {};
  if (f.sourceUrl && /^https:\/\//.test(f.sourceUrl)) items.push(`<div class="source-item"><div><strong><a href="${esc(f.sourceUrl)}" target="_blank" rel="noopener noreferrer">模型使用的财报原文 ↗</a></strong><p>季度结束 ${displayDate(f.financialPeriodEnd)} · 发布 ${displayDate(f.financialAvailableAt)}</p></div><span class="source-state">一级来源</span></div>`);
  items.push('<div class="source-item"><div><strong><a href="data/financials.json">财报快照与人工核录说明 ↗</a></strong><p>季度发布后需要按原文核录；每日自动任务只刷新市场数据。</p></div><span class="source-state">可复核</span></div>');
  $('source-list').innerHTML = items.join('');
  $('limitations').innerHTML = `<p>${esc((analysis.limitations || []).join(' · '))}</p><details class="details"><summary>展开模型假设与需补事项</summary><ul>${[...(analysis.latest?.warnings || []),...(data.financialMetadata?.criticalGaps || []).map(note=>note.includes('默认估值现金不纳入')?'财报原始净现金代理未纳入公司自持USDC；当前V2按所选可用性折扣纳入，净现金桥见数据核对。':note)].map(note=>`<li>${esc(note)}</li>`).join('')}</ul></details>`;
  $('model-version').textContent = `模型 v${Model.MODEL_VERSION || '1.0'} · 生成 ${displayDate(data.metadata?.generatedAt)}`;
}

function path(points, x, y, value) {
  let active = false;
  return points.map((p,index) => {
    const n = value(p);
    if (!finite(n)) { active = false; return ''; }
    const segment = `${active ? 'L' : 'M'}${x(index).toFixed(2)},${y(n).toFixed(2)}`;
    active = true;
    return segment;
  }).join(' ');
}
function renderCharts() {
  let all = analysis.history || [];
  if (range !== 'all' && all.length) {
    const from = new Date(`${all.at(-1).date}T00:00:00Z`);
    from.setUTCDate(from.getUTCDate()-Number(range));
    all = all.filter(p => p.date >= from.toISOString().slice(0,10));
  }
  visibleHistory = all;
  if (!all.length) { $('price-chart').innerHTML = '<div class="chart-empty">完整日线不足，等待下一次数据更新。</div>'; $('score-chart').innerHTML = ''; return; }
  for (const score of [false,true]) {
    const host = $(score ? 'score-chart' : 'price-chart');
    const W = Math.max(320,Math.round(host.clientWidth)), H = score ? (W < 600 ? 125 : 145) : (W < 600 ? 265 : 355);
    const P = {l:W < 600 ? 39 : 52,r:score?13:W<600?95:120,t:18,b:28}, plotW = W-P.l-P.r, plotH = H-P.t-P.b;
    const x = index => P.l+index/Math.max(1,all.length-1)*plotW;
    let min = 0,max = 100;
    if (!score) {
      const values = all.flatMap(p => [p.price,p.bearPrice,p.bullPrice]).concat(Object.values(analysis.latest?.priceMap||{}).map(point=>point?.price)).filter(finite);
      min = Math.max(0,Math.min(...values)*.85);
      max = Math.max(...values)*1.10;
      if (min === max) max += 1;
    }
    const y = value => P.t+(1-(value-min)/(max-min))*plotH;
    let markup = '';
    const ticks = score ? [0,50,100] : Array.from({length:5},(_,i)=>min+(max-min)*i/4);
    for (const tick of ticks) markup += `<line x1="${P.l}" x2="${W-P.r}" y1="${y(tick)}" y2="${y(tick)}" stroke="#344657" stroke-width=".7"/><text class="chart-tick" x="${P.l-7}" y="${y(tick)+3}" text-anchor="end">${score ? tick : `$${Math.round(tick)}`}</text>`;
    const tickCount = W < 600 ? 3 : 6;
    for (let k=0;k<tickCount;k++) {
      const index = Math.round(k/(tickCount-1)*(all.length-1));
      markup += `<text class="chart-tick" x="${x(index)}" y="${H-6}" text-anchor="${k===0?'start':k===tickCount-1?'end':'middle'}">${all[index].date.slice(2)}</text>`;
    }
    if (score) {
      for (const [key,color,threshold] of [['buyScore','#66c39a',defaultSettings.qualityCore],['sellScore','#f0848c',null]]) {
        markup += `<line x1="${P.l}" x2="${W-P.r}" y1="${finite(threshold)?y(threshold):-100}" y2="${finite(threshold)?y(threshold):-100}" stroke="${color}" opacity=".25" stroke-dasharray="3,5"/><path d="${path(all,x,y,p=>p[key])}" stroke="${color}" stroke-width="1.8" fill="none"/>`;
      }
    } else {
      let segment = [];
      const flush = () => {
        if (!segment.length) return;
        const polygon = segment.map(({p,index})=>`${x(index)},${y(p.bullPrice)}`).concat([...segment].reverse().map(({p,index})=>`${x(index)},${y(p.bearPrice)}`)).join(' ');
        markup += `<polygon points="${polygon}" fill="#4eb9c8" fill-opacity=".08"/>`;
        segment = [];
      };
      all.forEach((p,index) => { if (finite(p.bearPrice) && finite(p.bullPrice)) segment.push({p,index}); else flush(); }); flush();
      for (const [key,color,dash,width] of [['bearPrice','#4eb9c8','3,5',.7],['bullPrice','#4eb9c8','3,5',.7],['basePrice','#4eb9c8','5,4',1.3],['price','#e0c882','',2]]) markup += `<path d="${path(all,x,y,p=>p[key])}" stroke="${color}" stroke-width="${width}" fill="none" ${dash ? `stroke-dasharray="${dash}" opacity=".7"` : ''}/>`;
      all.forEach((p,index) => {
        if (!p.marker) return;
        const buy = p.marker.type === 'buy', color = buy ? '#66c39a' : '#f0848c';
        const px=x(index), py=y(p.price)+(buy?9:-9);
        const symbol = p.marker.type === 'exit' ? `<path d="M${px-4},${py-4}L${px+4},${py+4}M${px+4},${py-4}L${px-4},${py+4}" stroke="${color}" stroke-width="2"/>` : `<path d="M${px},${py+(buy?-5:5)}L${px-4},${py+(buy?3:-3)}L${px+4},${py+(buy?3:-3)}Z" fill="${color}"/>`;
        markup += `<g><title>${esc(`${p.date} ${p.marker.label || p.action} · ${money(p.price)}`)}</title>${symbol}</g>`;
      });
    }
    if(!score) {
      const points=Object.entries(analysis.latest?.priceMap||{}).filter(([key,point])=>['trial','core','trim','extreme'].includes(key)&&finite(point.price)).map(([key,point])=>({key,point,actualY:y(point.price),labelY:y(point.price)})).sort((a,b)=>a.actualY-b.actualY);
      for(let i=0;i<points.length;i++)points[i].labelY=Math.max(P.t+8,points[i].actualY,i?points[i-1].labelY+18:P.t+8);
      const overflow=points.length?Math.max(0,points.at(-1).labelY-(H-P.b-8)):0;
      const labelNames={trial:'试探',core:'核心',trim:'减仓',extreme:'复核'};
      for(const item of points) {
        item.labelY-=overflow;
        const color=['trial','core'].includes(item.key)?'#66c39a':'#f0848c',edge=W-P.r;
        markup+='<g class="current-level-marker" data-level="'+item.key+'" data-price="'+item.point.price+'" opacity="'+(analysis.latest?.dataBlockers?.length ? 0.5 : 1)+'"><title>'+esc('当前假设条件：'+labelNames[item.key]+' '+money(item.point.price)+'；截至'+analysis.latest.date+(analysis.latest?.dataBlockers?.length?'，条件参考，暂停行动':''))+'</title><line x1="'+(edge-7)+'" x2="'+(edge+5)+'" y1="'+item.actualY+'" y2="'+item.actualY+'" stroke="'+color+'" stroke-width="2"/><path d="M'+(edge+5)+','+item.actualY+'L'+(edge+11)+','+item.labelY+'" stroke="'+color+'" fill="none"/><text x="'+(edge+14)+'" y="'+(item.labelY+3)+'" fill="'+color+'" font-size="10">'+labelNames[item.key]+' '+money(item.point.price)+'</text></g>';
      }
      $('chart-current-levels').textContent=points.length?'右端四个短标记仅表示当前假设的价格条件，日期 '+displayDate(analysis.latest.date)+(analysis.latest?.dataBlockers?.length?'，条件参考，当前行动暂停。':'；其余基本面、行情和预算条件另行核对。')+' 修改参数会更新短标记，历史曲线和候选时点保持固定研究基线。':'当前正常研究中枢不适用，右端价线留空；历史曲线仅供固定基线对照，查看情景及条件清单原因。';
    }
    markup += `<line class="cursor-line" x1="0" x2="0" y1="${P.t}" y2="${H-P.b}" stroke="#aab8c9" stroke-dasharray="3,3" visibility="hidden"/><rect class="chart-hit" x="${P.l}" y="${P.t}" width="${plotW}" height="${plotH}" fill="transparent"/>`;
    host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" aria-hidden="true">${markup}</svg>`;
    host.dataset.plotLeft=P.l; host.dataset.plotWidth=plotW;
    host.tabIndex=0;
    host.setAttribute('aria-label',score?'历史买入与减仓评分图，左右键查看日期':'CRCL价格、当时估值与候选买卖点图，左右键查看日期');
    host.onpointermove = event => {
      const rect=host.getBoundingClientRect();
      const logicalX=(event.clientX-rect.left)*W/rect.width;
      selectChartDate(Math.max(0,Math.min(all.length-1,Math.round((logicalX-P.l)/plotW*(all.length-1)))));
    };
    host.onclick = host.onpointermove;
    host.onkeydown = event => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      selectChartDate(Math.max(0,Math.min(all.length-1,(selectedIndex < 0 ? all.length-1 : selectedIndex)+(event.key==='ArrowLeft'?-1:1))));
    };
  }
  selectedIndex = -1;
  selectChartDate(all.length-1);
}
function selectChartDate(index) {
  selectedIndex = index;
  const p = visibleHistory[index];
  if (!p) return;
  for (const id of ['price-chart','score-chart']) {
    const host = $(id), cursor = host.querySelector('.cursor-line');
    if (!cursor) continue;
    const x = Number(host.dataset.plotLeft)+index/Math.max(1,visibleHistory.length-1)*Number(host.dataset.plotWidth);
    cursor.setAttribute('x1',x);cursor.setAttribute('x2',x);cursor.setAttribute('visibility','visible');
  }
  $('chart-readout').textContent = `${p.date} · 收盘 ${money(p.price)} · 当时 Base ${money(p.basePrice)} · 质量 ${finite(p.buyScore)?number(p.buyScore,1):'—'} / 溢价压力 ${finite(p.sellScore)?number(p.sellScore,1):'—'} · ${p.action || '数据不足'}${finite(p.indicators?.rsi14)?` · RSI ${number(p.indicators.rsi14,1)}`:''}`;
}
function recalculate() {
  analysis = {...analysis,settings,latest:Model.evaluateSnapshot(data,analysis.latest.date,settings,{latest:true,asOf:new Date().toISOString().slice(0,10)})};
  renderDecision();renderScenarios();renderIndicators();renderBacktest();renderSources();syncSettings();
  renderResearch(analysis,settings,researchState,Model);
  // Refresh current-condition markers; the historical data and replay stay frozen.
  renderCharts();
}

async function start() {
  const response = await fetch('./data/market-data.json', {cache:'no-cache'});
  if (!response.ok) throw new Error(`数据快照读取失败（${response.status}），请稍后刷新。`);
  data = await response.json();
  if (!data.financials) {
    const financialResponse = await fetch('./data/financials.json', {cache:'no-cache'});
    if (!financialResponse.ok) throw new Error('财报快照未找到，暂不产生买卖信号。');
    const financial = await financialResponse.json();
    data.financials = Array.isArray(financial) ? financial : financial.financials;
    data.shares = data.shares?.length ? data.shares : financial.shares;
    data.financialMetadata = financial.metadata;data.financialRecasts=financial.recasts;
    data.metadata.sources.financials = {status:'verified',asOf:financial.financials?.at(-1)?.periodEnd,fetchedAt:financial.metadata?.asOfDate,url:financial.financials?.at(-1)?.sourceUrl};
  }
  const contextResponse=await fetch('./data/valuation-context.json',{cache:'no-cache'});
  if(!contextResponse.ok)throw new Error('新估值路径上下文未载入，暂停使用旧价格线。');
  data.valuationContext=await contextResponse.json();
  restoreSettings();
  analysis = Model.analyze(data,settings);
  buildSettings();buildPortfolioForm();renderDecision();renderScenarios();renderIndicators();renderBacktest();renderSources();
  renderResearch(analysis,settings,researchState,Model);
  $('loading-status').hidden = true;
  $('decision-surface').hidden = false;
  renderCharts();
  let lastWidth=0;
  new ResizeObserver(entries => {
    const width = Math.round(entries[0].contentRect.width);
    if (width !== lastWidth) { lastWidth=width; renderCharts(); }
  }).observe($('trade-chart'));
  $('export-data').disabled = false;
  $('export-research').disabled = false;
}
document.querySelectorAll('[data-range]').forEach(button => button.addEventListener('click',()=>{
  range=button.dataset.range;
  document.querySelectorAll('[data-range]').forEach(b => { b.classList.toggle('selected',b===button); b.setAttribute('aria-pressed',String(b===button)); });
  renderCharts();
}));
$('reset-settings').addEventListener('click',()=>{ settings=structuredClone(defaultSettings);$('settings-feedback').textContent='已恢复基准假设和风险开关；账户输入仍保留。';recalculate(); });
document.querySelectorAll('[data-stress]').forEach(button => button.addEventListener('click',()=>{
  const stress=button.dataset.stress;
  const constraints=[];
  for (const key of ['bear','base','bull']) {
    const s=settings.scenarios[key];
    if (['rates','combined'].includes(stress)) s.rateShift=Math.max(-.025,s.rateShift-.01);
    if (['usdc','combined'].includes(stress)) {const next=2*((1+s.usdcGrowthStart/2)*.8-1);s.usdcGrowthStart=Math.max(-.9,next);if(s.usdcGrowthStart!==next)constraints.push(key+'规模路径');}
    if (['retention','combined'].includes(stress)) s.retentionShiftEnd=Math.max(-.2,s.retentionShiftEnd-.05);
  }
  $('settings-feedback').textContent=`已在当前假设上叠加一次冲击；保留所选模型及风险开关。${constraints.length?constraints.join('、')+'达到输入边界。':''}`;
  recalculate();
}));
$('sensitivity-table').addEventListener('click',event=>{
  const button=event.target.closest('button[data-growth]');
  if (!button) return;
  const updates={usdcGrowthStart:Number(button.dataset.growth),requiredReturn:Number(button.dataset.return)};
  for (const [field,value] of Object.entries(updates)) {
    linkScenarioField(field,value);
  }
  recalculate();
  $('sensitivity-table').querySelector('.current-cell')?.focus({preventScroll:true});
});
$('event-risk').addEventListener('change',event=>{ settings.eventRisk=event.target.value;recalculate(); });
$('depeg-risk').addEventListener('change',event=>{ settings.depeg=event.target.checked;recalculate(); });
$('valuation-method').addEventListener('change',event=>{settings.relativeWeight={intrinsic:0,balanced:.5,growth:.75}[event.target.value];recalculate();});
$('compensation-mode').addEventListener('change',event=>{settings.compensationMode=event.target.value;recalculate();});
$('opex-includes-payroll').addEventListener('change',event=>{settings.opexIncludesSBCPayrollTax=event.target.checked;recalculate();});
$('include-pending-deals').addEventListener('change',event=>{settings.includePendingDeals=event.target.checked;recalculate();});
document.querySelectorAll('[data-position]').forEach(button=>button.addEventListener('click',()=>{
  researchState.positionView=button.dataset.position;
  document.querySelectorAll('[data-position]').forEach(b=>{b.classList.toggle('selected',b===button);b.setAttribute('aria-pressed',String(b===button));});
  renderResearch(analysis,settings,researchState,Model);
}));
$('portfolio-form').addEventListener('submit',event=>event.preventDefault());
$('portfolio-form').addEventListener('change',()=>{
  researchState.portfolio=readPortfolioForm();researchState.demo=false;
  $('budget-demo-label').textContent=researchState.portfolio?'按自行填写的假设账户测算；未连接券商。':'请填写全部预算字段，并保持现金和标的市值不超过账户总额。';
  renderResearch(analysis,settings,researchState,Model);
});
$('load-demo-account').addEventListener('click',()=>{
  const example={portfolioValue:100000,currentHoldingValue:0,availableCash:30000,maxWeight:.10,maxStressLoss:2000};
  fillPortfolioForm(example);researchState.portfolio=example;researchState.demo=true;
  $('budget-demo-label').textContent='演示账户：$100,000总资产、$30,000可用现金、10%标的权重、$2,000压力损失预算；不是你的账户或推荐配置。';
  renderResearch(analysis,settings,researchState,Model);
});
$('clear-account').addEventListener('click',()=>{
  fillPortfolioForm(null);researchState.portfolio=null;researchState.demo=false;
  $('budget-demo-label').textContent='账户输入已清空。';renderResearch(analysis,settings,researchState,Model);
});
const storageKey='stablemonitor:crcl:assumptions:v2.0';
function restoreSettings() {
  try {
    const raw=localStorage.getItem(storageKey);if(!raw){const previous=JSON.parse(localStorage.getItem('stablemonitor:crcl:assumptions:v1.1') || 'null');if(previous?.settings){settings.eventRisk=previous.settings.eventRisk==='high'?'high':'normal';settings.depeg=previous.settings.depeg===true;$('settings-feedback').textContent='V2已采用新估值参数；旧版风险开关保留，旧一年倍数参数未直接迁移。';}return;}
    const record=JSON.parse(raw),saved=record.settings;
    if(!saved || record.version!=='2.0')throw new Error('保存版本不兼容');
    const restored=structuredClone(defaultSettings);
    for(const [name,bounds] of Object.entries(scenarioLimits))for(const key of ['bear','base','bull']){
      const value=saved.scenarios?.[key]?.[name];
      if(!finite(value)||value<bounds[0]||value>bounds[1])throw new Error('保存参数超出范围');
      restored.scenarios[key][name]=value;
    }
    for(const field of fields.filter(f=>f.global)){
      const value=saved[field.key];if(value==null){restored[field.key]=defaultSettings[field.key];continue;}
      if(!finite(value)||value*field.factor<field.min||value*field.factor>field.max)throw new Error('保存参数超出范围');
      restored[field.key]=value;
    }
    if(![0,.5,.75].includes(saved.relativeWeight)||!['equity','cash'].includes(saved.compensationMode)||!['normal','high'].includes(saved.eventRisk))throw new Error('保存模式无效');
    restored.relativeWeight=saved.relativeWeight;restored.compensationMode=saved.compensationMode;restored.eventRisk=saved.eventRisk;
    restored.depeg=saved.depeg===true;restored.opexIncludesSBCPayrollTax=saved.opexIncludesSBCPayrollTax===true;restored.includePendingDeals=saved.includePendingDeals===true;
    settings=restored;
    $('settings-feedback').textContent='已载入本浏览器保存的研究假设；历史基线和账户输入不变。';
  } catch {
    settings=structuredClone(defaultSettings);
    $('settings-feedback').textContent='保存参数无法使用，已采用基准假设；可重新保存或导出研究快照。';
  }
}
$('save-settings').addEventListener('click',()=>{
  try{localStorage.setItem(storageKey,JSON.stringify({version:'2.0',savedAt:new Date().toISOString(),settings}));$('settings-feedback').textContent='研究假设已保存在当前浏览器；账户预算不自动保存。';}
  catch{$('settings-feedback').textContent='浏览器无法保存参数，可使用“导出当前研究快照”。';}
});
$('export-research').addEventListener('click',()=>{
  const l=analysis.latest;
  const report={version:Model.MODEL_VERSION,exportedAt:new Date().toISOString(),priceAsOf:l.date,evaluationAsOf:l.valuationV2?.current?.dataValidationAsOf,sourceMetadata:data.metadata,financialMetadata:data.financialMetadata,valuationContext:data.valuationContext,sourceHealth:inspectMarketSources(data,new Date().toISOString().slice(0,10)),economicChecks:buildEconomicChecks(l,data),settings,portfolio:researchState.portfolio,portfolioIsDemo:researchState.demo,decision:{rule:l.action,positionView:researchState.positionView,scenarios:l.scenarios,checklist:l.checklist,priceMap:l.priceMap,reverseV2:l.reverseV2,dataBlockers:l.dataBlockers,knownOperatingLoss:l.knownOperatingLoss,warnings:l.warnings},valuationInputs:l.valuationV2?.current,valuationBasis:{reserveRatePath:l.valuationV2?.reserveRatePath,capitalBasis:l.valuationV2?.capitalBasis,relativeBasis:l.valuationV2?.relativeBasis},valuationFundamentals:l.fundamentals,observedIndicators:l.indicators,historyFormulaVersion:analysis.historyFormulaVersion};
  const url=URL.createObjectURL(new Blob([JSON.stringify(report,null,2)],{type:'application/json'})),a=document.createElement('a');
  a.href=url;a.download=`CRCL-研究快照-${displayDate(analysis.latest.date)}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
});
$('export-data').addEventListener('click',()=>{
  const rows = [['date','close','normal_bear','research_center','normal_bull','fundamental_quality','premium_pressure','action','marker'],...(analysis.history||[]).map(p=>[p.date,p.price,p.bearPrice,p.basePrice,p.bullPrice,p.buyScore,p.sellScore,p.action,p.marker?.type])];
  const csv = '\uFEFF'+rows.map(row=>row.map(v=>`"${String(v??'').replace(/"/g,'""')}"`).join(',')).join('\r\n');
  const url=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'})),a=document.createElement('a');
  a.href=url;a.download=`CRCL-信号历史-${displayDate(analysis.latest?.date)}.csv`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
});
start().catch(error=>setStatus(error.message || '数据读取失败，请稍后刷新。',true));
