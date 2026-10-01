import * as Model from './crcl-model.js';
import {renderResearch,buildPortfolioForm,readPortfolioForm,fillPortfolioForm} from './crcl-usable.js';

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
const scenarioLimits={usdcGrowth:[-.9,1.5],yieldShift:[-.04,.03],retentionShift:[-.25,.25],otherGrowth:[-.5,1.5],opexGrowth:[-.3,.7],dilution:[0,.25],multiple:[5,60]};
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
function renderDecision() {
  const l = analysis.latest;
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
    ...((l?.blockers || []).map(text => ({text,danger:true})))
  ];
  $('decision-tags').innerHTML = tags.map(t => `<span class="tag${t.danger ? ' danger' : ''}">${esc(t.text)}</span>`).join('');
  $('risk-notice').textContent = l?.blockers?.length ? l.blockers.join(' · ') : '核心假设：经常性其他收入采用指引代理，股本采用稀释股数代理，未来资本承诺默认未计入。完整口径和需补项见页底；Bear 情景不是价格下限。';
  $('risk-notice').classList.toggle('warning', !!l?.blockers?.length);
  const s = l?.scenarios || {};
  const b = l?.positionBands || {};
  const cards = [
    ['buy','分批候选线',b.buyBelow ?? (finite(s.base?.price)?s.base.price*.85:null),'价格低于基准估值 85%，仍需买入分与风险门槛通过。'],
    ['buy','更大安全边际',b.addBelow ?? (finite(s.base?.price)?s.base.price*.70:null),'价格低于基准估值 70%，按上限分批；高分不免除回撤。'],
    ['sell','减仓候选线',b.trimAbove ?? (finite(s.base?.price)?s.base.price*1.25:null),'价格高于基准估值 125%，结合过热与减仓条件。'],
    ['','Bear 复核线',b.bearReview ?? s.bear?.price,'悲观情景价值，用于复核假设；不是自动止损价或底价。']
  ];
  $('position-bands').innerHTML = cards.map(([cls,title,value,note],index) => {
    const scenario=index<3?s.base:s.bear;
    const unpriced=finite(scenario?.forwardEBITDA)&&scenario.forwardEBITDA<=0;
    return `<article class="level-card ${cls}"><span class="level-title">${title}</span><strong>${unpriced?'不适用':money(value)}</strong><p>${unpriced?'盈利情景非正，不能用正数 EBITDA 倍数定价。':note}</p></article>`;
  }).join('');
  $('score-components').innerHTML = [['买入条件',l?.buyComponents,'buy'],['减仓条件',l?.sellComponents,'sell']].map(([name,components,cls])=>`<div class="component-column ${cls}"><h3>${name}</h3>${components?.length ? components.map(c=>`<div class="component-row"><span>${esc(c.label)}</span><strong>${number(c.value,1)} / ${c.max}</strong><div class="meter ${cls==='sell'?'sell':''}"><i style="width:${Math.max(0,Math.min(100,c.value/c.max*100))}%"></i></div></div>`).join('') : `<p class="muted">${l?.hardExit?'盈利非正，估值倍数不适用，暂停总分。':'关键数据不足，暂停评分。'}</p>`}</div>`).join('');
}

function renderScenarios() {
  const l = analysis.latest;
  const cases = l?.scenarios || {};
  const labels = {bear:'Bear · 收缩与压力',base:'Base · 温和扩张',bull:'Bull · 规模与留存改善'};
  const notes = {bear:'降息、供应承压、渠道留存下降与费用刚性。',base:'规模扩张与降息抵消，保留成本和稀释。',bull:'规模、渠道留存与经常性业务共同改善。'};
  $('scenario-cards').innerHTML = ['bear','base','bull'].map(key => {
    const s = cases[key] || {};
    const upside = finite(s.price) && finite(l?.price) ? s.price/l.price-1 : null;
    const unpriced = finite(s.forwardEBITDA) && s.forwardEBITDA <= 0;
    return `<article class="scenario-card ${key}${unpriced?' unpriced':''}"><h3>${labels[key]}</h3><div class="scenario-price">${unpriced?'倍数不适用':money(s.price)}</div><p class="scenario-upside">${unpriced?'预期亏损，需另行估值':`相对收盘 ${pct(upside,1,true)}`}</p><p>${notes[key]}</p><dl><dt>平均 USDC</dt><dd>${dollars(s.averageUSDC)}</dd><dt>经营利润代理</dt><dd>${dollars(s.forwardEBITDA)}</dd><dt>收益率 / 留存</dt><dd>${pct(s.reserveYield)} / ${pct(s.reserveRetention)}</dd><dt>EV / 利润代理</dt><dd>${number(s.assumptions?.multiple ?? settings.scenarios[key].multiple)}x</dd></dl></article>`;
  }).join('');
  const metrics = [
    ['期末 USDC 增长假设','assumptions',a => pct(a?.usdcGrowth,1,true)],['未来利率变化','assumptions',a => finite(a?.yieldShift)?`${number(a.yieldShift*10000,0)}bp`:'需补'],['EV / EBITDA 假设','assumptions',a => finite(a?.multiple)?`${number(a.multiple)}x`:'需补'],
    ['平均 USDC','averageUSDC',dollars],['储备收益率','reserveYield',pct],['储备收入留存','reserveRetention',pct],
    ['经常性其他收入 / 年','annualRecurringOtherRevenue',dollars],['调整后经营费用 / 年','annualAdjustedOpex',dollars],
    ['现金SBC工资税 / 年代理','annualSBCPayrollTax',dollars],['现金薪酬替代 / 年代理','annualRecurringSBC',dollars],
    ['经营利润代理（非报告 EBITDA）','forwardEBITDA',dollars],['企业价值','enterpriseValue',dollars],['企业净现金','corporateNetCash',dollars],
    ['未来资本承诺','futureCapitalCommitments',dollars],['稀释股数代理','dilutedShares',n => finite(n) ? `${number(n/1e6,1)}M` : '需补'],['股权价值','equityValue',dollars],['每股情景价格','price',money]
  ];
  $('scenario-table').innerHTML = table(['计算项','Bear','Base','Bull'], metrics.map(([label,key,fmt]) => [label,...['bear','base','bull'].map(k => {
    const c=cases[k];
    return ['price','enterpriseValue','equityValue'].includes(key)&&finite(c?.forwardEBITDA)&&c.forwardEBITDA<=0?'不适用（盈利非正）':fmt(c?.[key]);
  })]));
  renderSensitivity();
}

const fields = [
  {key:'usdcGrowth',label:'未来期末 USDC 规模变化',unit:'%',factor:100,min:-90,max:150,step:1,note:'以30日均值为锚，按线性路径取期间平均'},
  {key:'yieldShift',label:'未来储备收益率变动',unit:'bp',factor:10000,min:-400,max:300,step:10,note:'相对当前实际收益率 / 短端校准值'},
  {key:'retentionShift',label:'储备留存率变动',unit:'pp',factor:100,min:-25,max:25,step:.5,note:'渠道分成改善为正，恶化为负'},
  {key:'otherGrowth',label:'经常性其他收入增长',unit:'%',factor:100,min:-50,max:150,step:5,note:'剔除 ARC 预售等一次性项目'},
  {key:'opexGrowth',label:'调整后经营费用增长',unit:'%',factor:100,min:-30,max:70,step:1,note:'不含用估值倍数隐含的股东成本'},
  {key:'dilution',label:'代理外新增薪酬经济稀释',unit:'%',factor:100,min:0,max:25,step:.5,note:'权益模式使用；现金替代模式取消同份稀释'},
  {key:'multiple',label:'EV / 经营利润代理倍数',unit:'x',factor:1,min:5,max:60,step:1,note:'研究设定；不等于报告 EBITDA 倍数'},
  {key:'reserveYieldOverride',label:'当前储备收益率覆盖值',unit:'%',factor:100,min:.1,max:8,step:.1,note:'留空按实际储备收益率校准',global:true},
  {key:'annualOpexOverride',label:'年调整后经营费用覆盖值',unit:'$M',factor:1e-6,min:100,max:2000,step:5,note:'默认指引中点不含SBC与相关工资税',global:true},
  {key:'dilutedSharesOverride',label:'稀释股数代理覆盖值',unit:'M',factor:1e-6,min:100,max:1000,step:1,note:'留空使用当时已披露的股数代理',global:true},
  {key:'annualRecurringOtherRevenueOverride',label:'经常性其他收入 / 年覆盖值',unit:'$M',factor:1e-6,min:0,max:1500,step:5,note:'默认历史指引代理；预售不能直接年化',global:true},
  {key:'otherContributionMarginOverride',label:'其他收入贡献率覆盖值',unit:'%',factor:100,min:0,max:100,step:1,note:'会计代理，未披露真实分部贡献率',global:true},
  {key:'corporateNetCashOverride',label:'企业净现金覆盖值',unit:'$M',factor:1e-6,min:-2000,max:10000,step:10,note:'排除客户储备与ARC预收；可显式调整',global:true},
  {key:'futureCapitalCommitmentsOverride',label:'未来资本承诺 / 现金占用',unit:'$M',factor:1e-6,min:0,max:5000,step:10,note:'默认0为需补假设；股权支付进入稀释',global:true},
  {key:'annualSBCPayrollTaxOverride',label:'年现金工资税覆盖值',unit:'$M',factor:1e-6,min:0,max:200,step:1,note:'留空使用4×季税额代理，不是官方NTM数',global:true},
  {key:'annualRecurringSBCOverride',label:'年现金薪酬替代覆盖值',unit:'$M',factor:1e-6,min:0,max:1500,step:5,note:'现金模式使用4×P&L SBC；资本化SBC另列',global:true},
  {key:'financingDilution',label:'额外融资 / 并购新增权益',unit:'%',factor:100,min:0,max:50,step:.5,note:'与薪酬模式分开计入，不扣相同现金对价',global:true}
];
function buildSettings() {
  $('settings-form').innerHTML = fields.map(f => `<div class="setting"><label for="input-${f.key}">${f.label}</label><div class="setting-input"><input type="number" id="input-${f.key}" name="${f.key}" min="${f.min}" max="${f.max}" step="any" inputmode="decimal" aria-describedby="note-${f.key}"><span class="unit">${f.unit}</span></div><small id="note-${f.key}">${f.note}</small></div>`).join('');
  syncSettings();
  $('settings-form').addEventListener('submit', e => e.preventDefault());
  $('settings-form').addEventListener('change', event => {
    const f = fields.find(f => f.key === event.target.name);
    if (!f) return;
    const input = event.target;
    if (input.value === '' && f.global) settings[f.key] = f.key==='financingDilution'?defaultSettings.financingDilution:null;
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
      const automatic = {reserveYieldOverride:fundamentals.currentReserveYield,annualOpexOverride:fundamentals.annualAdjustedOpex,dilutedSharesOverride:fundamentals.dilutedShares,annualRecurringOtherRevenueOverride:fundamentals.annualRecurringOtherRevenue,otherContributionMarginOverride:fundamentals.otherContributionMargin,corporateNetCashOverride:fundamentals.corporateNetCash,futureCapitalCommitmentsOverride:fundamentals.futureCapitalCommitments,annualSBCPayrollTaxOverride:4*(fundamentals.sbcPayrollTaxes ?? fundamentals.SBCPayrollTaxes),annualRecurringSBCOverride:4*fundamentals.stockBasedCompensationExpense,financingDilution:0}[f.key];
      $(`input-${f.key}`).placeholder = finite(automatic) ? number(automatic*f.factor,2) : '需补';
    }
  }
  $('event-risk').value = settings.eventRisk;
  $('depeg-risk').checked = settings.depeg;
  $('valuation-method').value = settings.valuationMethod || 'retained-reserve';
  $('compensation-mode').value = settings.compensationMode || 'equity';
  $('opex-includes-payroll').checked = !!settings.opexIncludesSBCPayrollTax;
  $('input-dilution').disabled = settings.compensationMode==='cash';
  $('input-annualRecurringSBCOverride').disabled = settings.compensationMode!=='cash';
  $('input-annualSBCPayrollTaxOverride').disabled = !!settings.opexIncludesSBCPayrollTax;
}
function renderSensitivity() {
  const f = analysis.latest?.fundamentals;
  if (!f) { $('sensitivity-table').innerHTML = table(['等待数据'],[['核心数据不足']]); return; }
  const currentYield = settings.reserveYieldOverride ?? f.currentReserveYield;
  if (!finite(currentYield)) {$('sensitivity-table').innerHTML=table(['等待数据'],[['缺少有效储备收益率，无法生成价格矩阵']]);return;}
  const baseYield = currentYield + settings.scenarios.base.yieldShift;
  const yields = [...new Set([-.01,-.005,0,.005,.01].map(delta => Math.max(.001,Math.max(currentYield+scenarioLimits.yieldShift[0],Math.min(currentYield+scenarioLimits.yieldShift[1],baseYield+delta)))))];
  const growths = [...new Set([-.20,-.10,0,.10,.20].map(delta => Math.max(scenarioLimits.usdcGrowth[0],Math.min(scenarioLimits.usdcGrowth[1],settings.scenarios.base.usdcGrowth+delta))))];
  const rows = growths.map((growth,ri) => `<tr><th scope="row">${pct(growth,0,true)}</th>${yields.map((yieldValue,ci) => {
    const a = {...settings.scenarios.base,usdcGrowth:growth,yieldShift:yieldValue-currentYield};
    const scenario = Model.calculateScenario(f,a,settings);
    const value = scenario?.price;
    const relative = finite(value) && analysis.latest.price > 0 ? Math.max(-1,Math.min(1,value/analysis.latest.price-1)) : 0;
    const color = relative >= 0 ? `rgba(102,195,154,${.07+relative*.2})` : `rgba(240,132,140,${.07-relative*.2})`;
    const unpriced=finite(scenario?.forwardEBITDA)&&scenario.forwardEBITDA<=0;
    const text=unpriced?'不适用':money(value),usable=finite(value)||finite(scenario?.forwardEBITDA);
    const current=Math.abs(growth-settings.scenarios.base.usdcGrowth)<1e-9&&Math.abs(yieldValue-baseYield)<1e-9;
    return `<td><button type="button" data-growth="${growth}" data-yield="${yieldValue}" style="background:${color}" class="${current?'current-cell':''}" aria-pressed="${current}" ${usable?'':'disabled'} aria-label="期末USDC变化${pct(growth,0)}，收益率${pct(yieldValue,2)}，情景价格${text}${unpriced?'，预期盈利非正':''}">${text}</button></td>`;
  }).join('')}</tr>`);
  $('sensitivity-table').innerHTML = `<thead><tr><th scope="col">期末规模变化 / 收益率</th>${yields.map(y => `<th scope="col">${pct(y,2)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody>`;
}

function renderIndicators() {
  const l = analysis.latest || {}, i = l.indicators || {}, f = l.fundamentals || {}, s = l.scenarios || {};
  const rows = [
    ['USDC 当前规模',dollars(f.currentUSDC),'期末观察值；估值进一步假设未来平均规模'],
    ['USDC · 7 / 30 日',`${pct(i.usdc7d,1,true)} / ${pct(i.usdc30d,1,true)}`,'按期初规模计算净变化，缺失留空'],
    ['USDC · 90 日',pct(i.usdc90d,1,true),'绝对增长与竞争份额共同观察'],
    ['USDC 市占 / 90 日变化',`${pct(i.marketShare)} / ${finite(i.marketShare90d)?`${number(i.marketShare90d*100,2)}pp`:'需补'}`,'美元稳定币全市场口径'],
    ['当前储备收益率',pct(f.currentReserveYield,2),'实际储备收益率按短端利率变化校准'],
    ['储备收入留存',pct(f.reserveRetention,2),'储备收入扣分销交易成本后的留存'],
    ['RLDC 利润率',pct(f.rldcMargin,2),'全部收入扣全部相关成本，不等于储备留存'],
    ['渠道分销成本占比',pct(f.distributionRatio,2),'全部分销及交易成本，不全部归因 Coinbase'],
    ['经常性其他收入 · 假设',dollars(settings.annualRecurringOtherRevenueOverride ?? f.annualRecurringOtherRevenue),'历史全年指引中点代理；未单列真实经常性金额'],
    ['年调整后经营费用 · 假设',dollars(settings.annualOpexOverride ?? f.annualAdjustedOpex),'已知全年指引中点；未来增长另行假设'],
    ['稀释股数代理',finite(f.dilutedShares)?`${number(f.dilutedShares/1e6,1)}M`:'需补',`已披露代理；截至 ${displayDate(f.shareAsOf)}`],
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
  const sources = data.metadata?.sources || {};
  const titles = {prices:'日线价格 · Yahoo Finance',CRCL:'CRCL 日线 · Yahoo Finance',SPY:'SPY 日线 · Yahoo Finance',usdc:'USDC · DefiLlama',totalStablecoins:'美元稳定币总量 · DefiLlama',rates:'短端利率 · 纽约联储 SOFR',financials:'季度财报 · Circle / SEC'};
  const items = Object.entries(sources).map(([key,source]) => {
    const url = /^https:\/\//.test(source.url || '') ? source.url : null;
    const status = source.status || '需补';
    const ok = ['ok','verified','fresh'].includes(status);
    const statusLabel={fresh:'已更新',verified:'原文核实',cached:'缓存 · 更新失败',failed:'更新失败',ok:'已更新'}[status] || status;
    return `<div class="source-item"><div><strong>${url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(titles[key] || key)} ↗</a>` : esc(titles[key] || key)}</strong><p>数据截至 ${displayDate(source.asOf)} · 采集 ${displayDate(source.fetchedAt || data.metadata?.generatedAt)}</p>${source.error ? `<p>${esc(source.error)}</p>` : ''}</div><span class="source-state${ok ? '' : ' warn'}">${esc(statusLabel)}</span></div>`;
  });
  const f = analysis.latest?.fundamentals || {};
  if (f.sourceUrl && /^https:\/\//.test(f.sourceUrl)) items.push(`<div class="source-item"><div><strong><a href="${esc(f.sourceUrl)}" target="_blank" rel="noopener noreferrer">模型使用的财报原文 ↗</a></strong><p>季度结束 ${displayDate(f.financialPeriodEnd)} · 发布 ${displayDate(f.financialAvailableAt)}</p></div><span class="source-state">一级来源</span></div>`);
  items.push('<div class="source-item"><div><strong><a href="data/financials.json">财报快照与人工核录说明 ↗</a></strong><p>季度发布后需要按原文核录；每日自动任务只刷新市场数据。</p></div><span class="source-state">可复核</span></div>');
  $('source-list').innerHTML = items.join('');
  $('limitations').innerHTML = `<p>${esc((analysis.limitations || []).join(' · '))}</p><details class="details"><summary>展开模型假设与需补事项</summary><ul>${[...(analysis.latest?.warnings || []),...(data.financialMetadata?.criticalGaps || [])].map(note=>`<li>${esc(note)}</li>`).join('')}</ul></details>`;
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
    const P = {l:W < 600 ? 39 : 52,r:13,t:18,b:28}, plotW = W-P.l-P.r, plotH = H-P.t-P.b;
    const x = index => P.l+index/Math.max(1,all.length-1)*plotW;
    let min = 0,max = 100;
    if (!score) {
      const values = all.flatMap(p => [p.price,p.bearPrice,p.bullPrice]).filter(finite);
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
      for (const [key,color,threshold] of [['buyScore','#66c39a',defaultSettings.buyThreshold],['sellScore','#f0848c',defaultSettings.sellThreshold]]) {
        markup += `<line x1="${P.l}" x2="${W-P.r}" y1="${y(threshold)}" y2="${y(threshold)}" stroke="${color}" opacity=".25" stroke-dasharray="3,5"/><path d="${path(all,x,y,p=>p[key])}" stroke="${color}" stroke-width="1.8" fill="none"/>`;
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
  $('chart-readout').textContent = `${p.date} · 收盘 ${money(p.price)} · 当时 Base ${money(p.basePrice)} · 买入 ${finite(p.buyScore)?number(p.buyScore,1):'—'} / 减仓 ${finite(p.sellScore)?number(p.sellScore,1):'—'} · ${p.action || '数据不足'}${finite(p.indicators?.rsi14)?` · RSI ${number(p.indicators.rsi14,1)}`:''}`;
}
function recalculate() {
  analysis = {...analysis,settings,latest:Model.evaluateSnapshot(data,analysis.latest.date,settings,{latest:true,asOf:new Date().toISOString().slice(0,10)})};
  renderDecision();renderScenarios();renderIndicators();renderBacktest();renderSources();syncSettings();
  renderResearch(analysis,settings,researchState,Model);
  // Current assumptions never alter the historical baseline chart or backtest.
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
    data.financialMetadata = financial.metadata;
    data.metadata.sources.financials = {status:'verified',asOf:financial.financials?.at(-1)?.periodEnd,fetchedAt:financial.metadata?.asOfDate,url:financial.financials?.at(-1)?.sourceUrl};
  }
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
    if (['rates','combined'].includes(stress)) s.yieldShift=Math.max(-.04,s.yieldShift-.01);
    if (['usdc','combined'].includes(stress)) {const next=2*((1+s.usdcGrowth/2)*.8-1);s.usdcGrowth=Math.max(-.9,next);if(s.usdcGrowth!==next)constraints.push(key+'规模路径');}
    if (['retention','combined'].includes(stress)) s.retentionShift=Math.max(-.25,s.retentionShift-.05);
  }
  $('settings-feedback').textContent=`已在当前假设上叠加一次冲击；保留所选模型及风险开关。${constraints.length?constraints.join('、')+'达到输入边界。':''}`;
  recalculate();
}));
$('sensitivity-table').addEventListener('click',event=>{
  const button=event.target.closest('button[data-growth]');
  if (!button) return;
  const currentYield=settings.reserveYieldOverride ?? analysis.latest.fundamentals.currentReserveYield;
  const updates={usdcGrowth:Number(button.dataset.growth),yieldShift:Number(button.dataset.yield)-currentYield};
  for (const [field,value] of Object.entries(updates)) {
    linkScenarioField(field,value);
  }
  recalculate();
  $('sensitivity-table').querySelector('.current-cell')?.focus({preventScroll:true});
});
$('event-risk').addEventListener('change',event=>{ settings.eventRisk=event.target.value;recalculate(); });
$('depeg-risk').addEventListener('change',event=>{ settings.depeg=event.target.checked;recalculate(); });
$('valuation-method').addEventListener('change',event=>{settings.valuationMethod=event.target.value;recalculate();});
$('compensation-mode').addEventListener('change',event=>{settings.compensationMode=event.target.value;recalculate();});
$('opex-includes-payroll').addEventListener('change',event=>{settings.opexIncludesSBCPayrollTax=event.target.checked;recalculate();});
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
const storageKey='stablemonitor:crcl:assumptions:v1.1';
function restoreSettings() {
  try {
    const raw=localStorage.getItem(storageKey);if(!raw)return;
    const record=JSON.parse(raw),saved=record.settings;
    if(!saved || record.version!=='1.1')throw new Error('保存版本不兼容');
    const restored=structuredClone(defaultSettings);
    for(const [name,bounds] of Object.entries(scenarioLimits))for(const key of ['bear','base','bull']){
      const value=saved.scenarios?.[key]?.[name];
      if(!finite(value)||value<bounds[0]||value>bounds[1])throw new Error('保存参数超出范围');
      restored.scenarios[key][name]=value;
    }
    for(const field of fields.filter(f=>f.global)){
      const value=saved[field.key];if(value==null){restored[field.key]=field.key==='financingDilution'?defaultSettings.financingDilution:null;continue;}
      if(!finite(value)||value*field.factor<field.min||value*field.factor>field.max)throw new Error('保存参数超出范围');
      restored[field.key]=value;
    }
    if(!['retained-reserve','issuer-sensitivity'].includes(saved.valuationMethod)||!['equity','cash'].includes(saved.compensationMode)||!['normal','high'].includes(saved.eventRisk))throw new Error('保存模式无效');
    restored.valuationMethod=saved.valuationMethod;restored.compensationMode=saved.compensationMode;restored.eventRisk=saved.eventRisk;
    restored.depeg=saved.depeg===true;restored.opexIncludesSBCPayrollTax=saved.opexIncludesSBCPayrollTax===true;
    settings=restored;
    $('settings-feedback').textContent='已载入本浏览器保存的研究假设；历史基线和账户输入不变。';
  } catch {
    settings=structuredClone(defaultSettings);
    $('settings-feedback').textContent='保存参数无法使用，已采用基准假设；可重新保存或导出研究快照。';
  }
}
$('save-settings').addEventListener('click',()=>{
  try{localStorage.setItem(storageKey,JSON.stringify({version:'1.1',savedAt:new Date().toISOString(),settings}));$('settings-feedback').textContent='研究假设已保存在当前浏览器；账户预算不自动保存。';}
  catch{$('settings-feedback').textContent='浏览器无法保存参数，可使用“导出当前研究快照”。';}
});
$('export-research').addEventListener('click',()=>{
  const report={version:Model.MODEL_VERSION,exportedAt:new Date().toISOString(),priceAsOf:analysis.latest.date,sourceMetadata:data.metadata,settings,portfolio:researchState.portfolio,portfolioIsDemo:researchState.demo,decision:{rule:analysis.latest.action,positionView:researchState.positionView,scenarios:analysis.latest.scenarios,checklist:analysis.latest.checklist,reverseValuation:analysis.latest.reverseValuation},historyFormulaVersion:analysis.historyFormulaVersion};
  const url=URL.createObjectURL(new Blob([JSON.stringify(report,null,2)],{type:'application/json'})),a=document.createElement('a');
  a.href=url;a.download=`CRCL-研究快照-${displayDate(analysis.latest.date)}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
});
$('export-data').addEventListener('click',()=>{
  const rows = [['date','close','bear_value','base_value','bull_value','buy_score','sell_score','action','marker'],...(analysis.history||[]).map(p=>[p.date,p.price,p.bearPrice,p.basePrice,p.bullPrice,p.buyScore,p.sellScore,p.action,p.marker?.type])];
  const csv = '\uFEFF'+rows.map(row=>row.map(v=>`"${String(v??'').replace(/"/g,'""')}"`).join(',')).join('\r\n');
  const url=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'})),a=document.createElement('a');
  a.href=url;a.download=`CRCL-信号历史-${displayDate(analysis.latest?.date)}.csv`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
});
start().catch(error=>setStatus(error.message || '数据读取失败，请稍后刷新。',true));
