const $ = id => document.getElementById(id);
const finite = n => typeof n === 'number' && Number.isFinite(n);
const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const num = (n,d=1) => finite(n) ? n.toLocaleString('en-US',{minimumFractionDigits:d,maximumFractionDigits:d}) : '需补';
const money = n => finite(n) ? `$${num(n,2)}` : '需补';
const amount = n => finite(n) ? Math.abs(n)>=1e9?`$${num(n/1e9,2)}B`:`$${num(n/1e6,1)}M` : '需补';
const pct = (n,d=1) => finite(n)?`${num(n*100,d)}%`:'需补';
const budgetMoney=n=>finite(n)&&Math.abs(n)>=1e4?Math.abs(n)>=1e6?amount(n):`$${num(n/1000,2)}k`:money(n);
const metricRow = (label,value,note) => `<article class="research-metric"><span>${esc(label)}</span><strong>${esc(value)}</strong><p>${esc(note)}</p></article>`;

export function explainDecision(snapshot,positionView,allocation) {
  if(snapshot.decisionV2) {
    const l=snapshot,p=l.priceMap || {},d=l.decisionV2;
    if(l.dataBlockers?.length)return {title:'等待有效估值与数据',reason:l.dataBlockers.slice(0,2).join('；')};
    if(positionView==='held' && d.exitGate)return {title:'经营或趋势风险进入退出复核',reason:d.reasons?.join('；') || '复核风险，不是自动全卖指令。'};
    if(allocation?.configured && allocation.needReduceValue>0 && positionView==='held')return {title:'预算超限：复核减仓额度',reason:`按填写的联合压力和权重预算，应减少约 ${budgetMoney(allocation.needReduceValue)}；这是预算测算，不是已连接账户。`};
    if(l.decisionSettings?.eventRisk==='high'||l.decisionSettings?.depeg)return {title:'风险否决：暂停新增',reason:'人工风险开关优先，压力按钮保留该开关。'};
    if(positionView==='flat') {
      if(d.exitGate)return {title:'经营风险需复核，暂不新增',reason:d.reasons?.join('；') || '当前经营保护条件未通过。'};
      if(d.coreGate||d.trialGate)return {title:d.coreGate?'核心分批条件已到':'小仓试探条件已到',reason:allocation?.configured?`规则与预算共同放行上限 ${budgetMoney(allocation.actionableBuyValue)}。单次步速 ${pct(d.trancheFraction)}；不是自动成交。`:'价格和今日其他条件已到；未填账户预算，不生成个人金额。'};
      if(d.trimGate||d.extremeGate)return {title:'已进入估值减仓区，不追高',reason:'高估可以独立触发，不必等基本面先恶化；未持仓状态不产生卖出订单。'};
      return {title:'等待试仓价格条件',reason:`当前试仓要求 ${p.trial?.condition || '条件未完整'}。核心分批条件 ${p.core?.condition || '需补'}，不再另加旧70分门槛。`};
    }
    if(d.extremeGate)return {title:'高溢价进入仓位复核',reason:p.extreme?.condition || '极端价格条件已达到，复核剩余持仓理由。'};
    if(d.trimGate)return {title:'估值减仓条件已达到',reason:p.trim?.condition || '健康基本面不再阻止独立估值减仓。'};
    if(d.coreGate||d.trialGate)return {title:d.coreGate?'有条件核心增持':'有条件小仓增持',reason:'先核对账户现金、最大权重及联合压力预算；技术下行会放慢步速。'};
    return {title:'持仓复核：尚未到减仓条件',reason:`估值减仓条件 ${p.trim?.condition || '需补'}。采用不同定价研究路线会改变中枢；模型分歧一起列示。`};
  }
  const l=snapshot, failures=(l.checklist?.buy || []).filter(x=>x.pass===false);
  const missing=failures.slice(0,3).map(x=>x.label).join('、');
  const dataProblem=(l.blockers || []).some(x=>!x.includes('暂停新增'));
  if (allocation?.configured && allocation.needReduceValue>0 && positionView==='held') return {title:'预算超限：复核减仓额度',reason:`按你填写的预算，需要减少约 ${money(allocation.needReduceValue)} 的标的市值。行情条件另行列示，账户数据未经连接验证。`};
  if (dataProblem) return {title:'等待有效数据',reason:'关键来源或模型输入不满足要求。保留图表供查看，暂停当前买卖判断。'};
  if (positionView==='flat') {
    if ((l.blockers || []).length) return {title:'暂停新增：风险否决已开启',reason:'人工事件或脱锚开关优先于估值和分数；压力测试会保留这些开关。'};
    if (l.hardExit || l.exitGate) return {title:'暂不入场：风险条件已触发',reason:l.reasons?.[0] || '盈利或趋势风险需要复核。未持仓状态不产生卖出建议。'};
    if (l.buyGate) return {title:allocation?.configured && allocation.actionableBuyValue<=0?'买入条件已到，预算未放行':'满足分批条件：核对预算后再行动',reason:allocation?.configured?`按模拟预算，当前可新增上限 ${money(allocation.actionableBuyValue)}。这不是实际成交指令。`:'行情门槛已通过；尚未填写预算，不生成属于你的金额或股数。'};
    if (l.price>l.positionBands?.trimAbove) return {title:'不追买：基准估值偏贵',reason:`价格已越过减仓估值条件，但完整减仓规则还需共振。买入目前缺：${missing || '总分及风险条件'}。`};
    if (l.price>l.positionBands?.buyBelow) return {title:'等待安全边际',reason:`当前还未到分批价格条件。其他未满足项：${missing || '无'}。`};
    return {title:'价格条件已到，其他门槛未齐',reason:`价格线不等于自动买点。目前还缺：${missing || '完整触发条件'}。`};
  }
  if (l.exitGate || l.hardExit) return {title:'持仓进入退出复核',reason:l.reasons?.[0] || '风险退出条件优先于普通减仓分；交易仍须结合可用资金与实际成交条件。'};
  if (l.sellGate) return {title:'已满足减仓候选条件',reason:'估值、评分或基本面共振条件已触发。候选标记与实际执行记录分别列示。'};
  if ((l.blockers || []).length) return {title:'暂停加仓：风险否决已开启',reason:'现有持仓继续复核，人工风险开关已禁止新增。'};
  if (l.price>l.positionBands?.trimAbove) {
    const remaining=(l.checklist?.reduce || []).filter(x=>x.pass===false).map(x=>x.label).join('、');
    return {title:'估值偏高：复核持有理由',reason:`减仓的估值条件已到，完整规则尚缺：${remaining || '其他共振条件'}。这不代表估值中性；成本价不能替代未来收益判断。`};
  }
  return {title:l.buyGate?'满足增持条件：先核对预算':'继续复核持有条件',reason:missing?`新增资金仍需满足：${missing}。现有仓位、现金与压力损失预算在下方测算。`:'查看减仓、退出与预算条件后决定持仓动作。'};
}

function renderChecklist(l) {
  const kinds={price:'价格',score:'评分',fundamental:'基本面',trend:'趋势',risk:'风险',data:'数据'};
  const groups=l.decisionV2?[['trial','小仓试探'],['core','核心分批'],['trim','估值减仓'],['extreme','高溢价复核'],['exit','经营退出']]:[['buy','买入条件'],['reduce','减仓条件'],['exit','退出复核']];
  $('decision-checklist').innerHTML=groups.map(([key,title])=>{
    const rows=l.checklist?.[key] || [];
    const passed=rows.filter(x=>x.pass===true).length;
    return `<details class="checklist-group" ${['buy','trial','core'].includes(key)?'open':''}><summary>${title}<span>${passed} / ${rows.length} 条通过</span></summary><div class="checklist-rows">${rows.map(row=>`<div class="checklist-row"><span class="condition-state ${row.pass===true?'pass':row.pass===false?'fail':'unknown'}">${row.pass===true?'已满足':row.pass===false?'未满足':'需补'}</span><div><strong>${esc(row.label)}</strong><small>${esc(kinds[row.kind] || row.kind)} · 当前 ${esc(row.observed ?? row.current ?? '需补')} · 要求 ${esc(row.target ?? row.required ?? '需补')}</small></div></div>`).join('') || '<p class="muted">等待模型给出完整条件。</p>'}</div></details>`;
  }).join('');
  const summary=(l.checklist?.trial || l.checklist?.buy || []).filter(row=>row.pass===false);
  $('gap-summary').textContent=summary.length?`买入还差 ${summary.length} 项：${summary.slice(0,4).map(row=>row.label).join('、')}。价格达到参考线仍须检查其余条件。`:'买入门槛已齐；预算和实际成交条件在下方另外核对。';
}
function renderReverse(l) {
  if(l.valuationV2) {
    const vals=l.reverseV2 || {},base=l.scenarios?.base?.assumptions || {};
    const descriptors=[['usdcGrowthStart','首年USDC增长',pct],['rateShift','利率路径偏移',v=>finite(v)?`${num(v*10000,1)}bp`:'需补'],['retentionShiftEnd','第5年留存变化',v=>finite(v)?`${num(v*100,1)}pp`:'需补'],['requiredReturn','DCF股东回报要求',pct]];
    $('reverse-grid').innerHTML=descriptors.map(([key,label,fmt])=>{const r=vals[key] || {};return `<article class="reverse-card"><p>${label}</p><strong>${fmt(r.value)}</strong><span>当前Base：${fmt(base[key])}</span><small>${esc(r.reason || '等待完整估值路径')}</small></article>`;}).join('');
    const solved=Object.values(vals).filter(r=>r.achievable&&finite(r.reproducedPrice));
    $('reverse-proof').textContent=solved.length?`完整五年定价模型单变量代回现价；最大复现误差 ${money(Math.max(...solved.map(r=>Math.abs(r.reproducedPrice-l.price))))}。不是把单一年利润倒推后冒充五年路径。`:'反算条件不足或未求得经济域内解，保留需补。';
    const m=l.scenarios.base?.methods || {},v=l.valuationV2;
    $('relative-context').innerHTML=[['五年DCF',money(m.dcf?.price),`终值占经营价值 ${pct(m.dcf?.terminalShare)}；保守现金流视角`],['自身TTM定价参照',money(m.relative?.price),`基准倍数 ${num(m.relative?.multiple,1)}x · ${v.relativeBasis?.count || 0}个已知观察`],['研究中枢',money(l.scenarios.base?.price),'权重明确，两方法共享经营假设，不算两份独立证据']].map(([name,value,note])=>metricRow(name,value,note)).join('');
    $('relative-proof').textContent=`${v.relativeBasis?.method==='historical_ttm'?'使用当时已披露TTM及已公开重述，拒绝未来财报。':'自身历史不足，采用明确作者倍数假设。'} ${v.confidence?.reasons?.join('；') || ''}。成长退出3/5年只作终值假设诊断，不重复加入中枢权重。`;
    return;
  }
  const r=l.reverseValuation || {},s=l.scenarios?.base || {};
  const rows=[
    ['未来经营利润代理',amount(r.requiredEBITDA),amount(s.forwardEBITDA),'只求支撑现价的盈利额，非报告EBITDA或净利'],
    ['未来平均 USDC',amount(r.requiredAverageUSDC),amount(s.averageUSDC),'只调整规模；对应期末增长 '+pct(r.requiredEndUSDCGrowth)],
    ['储备收益率',pct(r.requiredReserveYield,2),pct(s.reserveYield,2),'只改变利率，其他输入固定'],
    ['储备收入留存',pct(r.requiredReserveRetention,2),pct(s.reserveRetention,2),'只改变渠道留存；桥接模式须按局部公式解释'],
    ['EV / 利润代理倍数',finite(r.requiredMultiple)?`${num(r.requiredMultiple,1)}x`:'需补',finite(s.assumptions?.multiple)?`${num(s.assumptions.multiple,1)}x`:'需补','只改变市场愿意给的倍数，不改变盈利']
  ];
  $('reverse-grid').innerHTML=rows.map(([label,required,current,note])=>`<article class="reverse-card"><p>${label}</p><strong>${required}</strong><span>当前 Base：${current}</span><small>${note}</small></article>`).join('');
  const checks=Object.values(r.checks || {});
  const possible=checks.filter(x=>x.achievable && finite(x.reproducedPrice));
  const maxError=possible.length?Math.max(...possible.map(x=>Math.abs(x.reproducedPrice-l.price))):null;
  $('reverse-proof').textContent=r.reason || (finite(maxError)?`已将可解的单变量结果代回当前公式；最大价格复现误差 ${money(maxError)}。这些条件互相独立，不能合并解释为同一个预测或概率。`:'反算条件不足；缺失或超出经济范围的解留空。');
  const c=l.valuationContext || {};
  const values=[
    ['代理 P/S',finite(c.ps)?`${num(c.ps,2)}x`:'需补','股数代理 × 价格 / 单季收入年化，非TTM'],
    ['EV / 报告 EBITDA',finite(c.evToReportedAnnualEBITDA)?`${num(c.evToReportedAnnualEBITDA,1)}x`:'需补','最新单季调整EBITDA年化，非未来盈利'],
    ['EV / RLDC',finite(c.evToAnnualRLDC)?`${num(c.evToAnnualRLDC,1)}x`:'需补','单季分销后收入年化，尚未扣经营费用']
  ];
  $('relative-context').innerHTML=values.map(([label,value,note])=>metricRow(label,value,note)).join('');
  const basis=l.decisionSettings?.dilutedSharesOverride!=null || l.decisionSettings?.corporateNetCashOverride!=null?'当前分子含手工股数或净现金覆盖值，分位是自定义假设对照，不能视为真实当前分位。':'';
  $('relative-proof').textContent=`${c.definition || '同口径单季年化代理'}。${basis}${Object.entries(c.percentiles || {}).map(([key,value])=>`${{ps:'P/S',evToReportedAnnualEBITDA:'EV/EBITDA',evToAnnualRLDC:'EV/RLDC'}[key] || key} 历史分位 ${finite(value?.percentile)?num(value.percentile,0)+'%':'需补'}（${value?.count || 0} 个观察）`).join('；')}。短样本分位只作参照，不直接生成买卖分。${(c.warnings || []).join(' ')}`;
}
function renderBudget(l,allocation) {
  if (!allocation?.configured) {
    $('budget-result').innerHTML=`<p class="budget-empty">${esc(allocation?.reason || '还未填写完整账户数据。')} 这里只显示行情条件，不生成属于你的金额或股数。可填写自己的假设，或载入明确标注的演示账户。</p>`;
    return;
  }
  const a=allocation;
  $('budget-result').innerHTML=`<div class="budget-stats">${[
    ['规则放行的新增上限',budgetMoney(a.actionableBuyValue),'行情和预算都通过时才大于0'],
    ['预算可容纳金额',budgetMoney(a.hypotheticalBuyValue),'假设行情条件通过，预算本身的上限'],
    ['需要减少的市值',budgetMoney(a.needReduceValue),'按输入权重和压力预算测算；k为千美元'],
    ['联合压力损失比例',pct(a.lossRate),'默认用独立联合压力情形，实际损失可能更大']
  ].map(([title,value,note])=>metricRow(title,value,note)).join('')}</div><p class="footnote">${esc(a.reason || '')} 现金余量 ${money(a.cashHeadroom)}；权重余量 ${money(a.weightHeadroom)}；压力损失预算剩余 ${money(a.stressHeadroom)}。${esc((a.warnings || []).join(' '))}</p>`;
}
function renderReplay(analysis) {
  const b=analysis.backtest || {},coverage=b.coverage || {};
  $('coverage-summary').innerHTML=[
    ['可评分交易日',coverage.scoredDays ?? '需补'],['财报窗口',coverage.reportWindows ?? '需补'],['独立买入段',coverage.buyEpisodes ?? '需补'],['实际成交',coverage.actualTrades ?? '需补'],['交易胜率',finite(coverage.winRate)?pct(coverage.winRate):'无有效样本']
  ].map(([label,value])=>`<div><span>${label}</span><strong>${esc(value)}</strong></div>`).join('');
  const rows=[['纪律组合',b.strategy],['全仓持有',b.buyAndHold],['同配置上限持有＋现金',b.sameAllocationHold],['固定节奏分批＋现金',b.scheduledDCA]];
  $('fair-benchmark-table').innerHTML=`<thead><tr><th>资金路径</th><th>总回报</th><th>最大回撤</th><th>平均仓位</th><th>期末价值</th></tr></thead><tbody>${rows.map(([name,v])=>`<tr><th>${esc(name)}</th><td>${pct(v?.totalReturn)}</td><td>${pct(v?.maxDrawdown)}</td><td>${pct(v?.averageExposure)}</td><td>${amount(v?.endingEquity)}</td></tr>`).join('')}</tbody>`;
  const curve=b.equityCurve || [];
  const host=$('equity-curve');
  if (!curve.length) {host.innerHTML='<p class="muted">数据不足，暂无可比较的资金路径。</p>';return;}
  const W=Math.max(320,host.clientWidth),H=190,P={l:50,r:15,t:15,b:26};
  const series=[['strategy','#c9a961'],['buyAndHold','#f0848c'],['sameAllocationHold','#4eb9c8'],['scheduledDCA','#66c39a']];
  const values=curve.flatMap(row=>series.map(([key])=>row[key]).filter(finite));
  const min=Math.min(...values)*.95,max=Math.max(...values)*1.05;
  const x=i=>P.l+i/Math.max(1,curve.length-1)*(W-P.l-P.r),y=v=>P.t+(max-v)/(max-min || 1)*(H-P.t-P.b);
  let svg='';
  for (let k=0;k<3;k++) {const v=min+(max-min)*k/2;svg+=`<line x1="${P.l}" x2="${W-P.r}" y1="${y(v)}" y2="${y(v)}" stroke="#344657"/><text class="chart-tick" x="${P.l-5}" y="${y(v)+3}" text-anchor="end">${num(v/1000,0)}k</text>`;}
  for (const [key,color] of series) {let pen=false;const d=curve.map((row,index)=>{if(!finite(row[key])){pen=false;return '';}const point=`${pen?'L':'M'}${x(index)},${y(row[key])}`;pen=true;return point;}).join(' ');svg+=`<path d="${d}" fill="none" stroke="${color}" stroke-width="1.5"/>`;}
  svg+=`<text class="chart-tick" x="${P.l}" y="${H-5}">${esc(curve[0].date)}</text><text class="chart-tick" x="${W-P.r}" y="${H-5}" text-anchor="end">${esc(curve.at(-1).date)}</text>`;
  host.innerHTML=`<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="纪律组合与三种持有分批对照的资金路径">${svg}</svg>`;
}
function renderFacts(l) {
  const f=l.fundamentals || {},p=f.previousFinancial || {};
  const change=(n,old)=>finite(n)&&old>0?pct(n/old-1):'需补';
  $('financial-driver-grid').innerHTML=[
    ['季均 / 季末 USDC',`${amount(f.avgUSDC)} / ${amount(f.eopUSDC)}`,'期末余额不等于可产生全年利息的平均规模'],
    ['渠道付款集中度',finite(f.coinbasePayments)?`${amount(f.coinbasePayments)} · ${pct(f.coinbasePayments/f.distributionAndTransactionCosts)}`:'需补','Coinbase付款 / 分销交易成本，约数口径'],
    ['Circle 平台占比',pct(f.onPlatformShare),'渠道位置观察，不自动证明黏性或利润率'],
    ['调整费用 / other 环比',`${change(f.quarterAdjustedOpex,p.quarterAdjustedOpex)} / ${change(f.otherRevenue,p.otherRevenue)}`,'费用上升与业务收入变动须一起观察'],
    ['季度 SBC / 现金工资税',`${amount(f.stockBasedCompensationExpense)} / ${amount(f.sbcPayrollTaxes ?? f.SBCPayrollTaxes)}`,'年度扣回采用4×季度代理，未当作官方未来指引'],
    ['资本化 SBC',amount(f.capitalizedStockBasedCompensationExpense),'未在相同经营利润桥再次扣除，另作再投资诊断']
  ].map(([label,value,note])=>metricRow(label,value,note)).join('');
}
export function renderResearch(analysis,settings,state,Model) {
  const l=analysis.latest;
  const allocation=Model.planAllocation ? Model.planAllocation(l,state.portfolio || {}) : null;
  renderChecklist(l);renderReverse(l);renderBudget(l,allocation);renderReplay(analysis);renderFacts(l);
  const conclusion=explainDecision(l,state.positionView,allocation);
  $('decision-title').textContent=conclusion.title;
  $('decision-reason').textContent=conclusion.reason;
  $('position-context-label').textContent=state.positionView==='held'?'已持仓：复核增减仓条件':'未持仓：识别新增条件';
  $('history-version-note').textContent=`主图是 ${analysis.historyFormulaVersion || 'V2研究重建'}，规则及情景编写于2026-10-02；只用其时可得宏观、财报和股票数据，未宣称当年已运营。旧版V1归档仍保留，改参数不重画本版本历史。`;
  return allocation;
}

export const portfolioFields=[
  {key:'portfolioValue',label:'账户总资产',unit:'USD',min:1,max:1e12,step:100,note:'包括现有持仓和现金的假设总额'},
  {key:'currentHoldingValue',label:'现有 CRCL 市值',unit:'USD',min:0,max:1e12,step:100,note:'自行填写，不连接券商读取'},
  {key:'availableCash',label:'可用现金',unit:'USD',min:0,max:1e12,step:100,note:'可用于该研究计划的现金'},
  {key:'maxWeight',label:'CRCL 最大账户权重',unit:'%',factor:100,min:0,max:100,step:1,note:'自定风险预算，不等于模型回放60%'},
  {key:'maxStressLoss',label:'允许联合压力损失',unit:'USD',min:0,max:1e12,step:100,note:'占当前持仓与新增金额的总压力损失预算'}
];
export function buildPortfolioForm() {
  $('portfolio-form').innerHTML=portfolioFields.map(f=>`<div class="setting"><label for="portfolio-${f.key}">${f.label}</label><div class="setting-input"><input id="portfolio-${f.key}" name="${f.key}" type="number" inputmode="decimal" min="${f.min}" max="${f.max}" step="any" aria-describedby="portfolio-note-${f.key}"><span class="unit">${f.unit}</span></div><small id="portfolio-note-${f.key}">${f.note}</small></div>`).join('');
}
export function readPortfolioForm() {
  const values={};
  for (const f of portfolioFields) {
    const input=$(`portfolio-${f.key}`);
    if (input.value==='' || !input.checkValidity()) return null;
    values[f.key]=Number(input.value)/(f.factor || 1);
  }
  return values;
}
export function fillPortfolioForm(values) {
  for (const f of portfolioFields) $(`portfolio-${f.key}`).value=finite(values?.[f.key])?values[f.key]*(f.factor || 1):'';
}
