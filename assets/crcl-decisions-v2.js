/**
 * Research decision rules, authored 2026-10-02. No fitted success probabilities.
 * All rates are decimals, price is USD, and allocation fractions are budget caps.
 * Fundamental entry and tactical trial are distinct routes; legacy scores do not
 * veto either route. Price maps freeze today's observed technical indicators.
 */
export const DECISION_VERSION = '2.0.0-research-2026-10-02';
export const DEFAULT_DECISION_SETTINGS = Object.freeze({
  targetUpsideTrial: 0.05, targetUpsideCore: 0.20,
  trimPremium: 0.15, extremePremium: 0.35,
  qualityTrial: 40, qualityCore: 50,
  trialTrancheFraction: 0.05, coreTrancheFraction: 0.15, trimTrancheFraction: 0.15,
  downtrendSpeedBudget: 0.5, eventRisk: 'normal', depeg: false
});

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const numeric = value => typeof value === 'number' && Number.isFinite(value);
const clamp = (value, low = 0, high = 1) => Math.max(low, Math.min(high, value));
const rounded = value => numeric(value) ? Math.round(value * 1e6) / 1e6 : null;
const scale = (value, low, high) => numeric(value) ? clamp((value - low) / (high - low)) : null;
const firstNumber = (...values) => values.find(numeric) ?? null;
const change = (current, previous) => numeric(current) && numeric(previous) && previous > 0 ? current / previous - 1 : null;
const profit = financial => firstNumber(financial?.adjustedEBITDA, financial?.cashEBITDAProxy, financial?.operatingIncome, financial?.operatingProfit);
const pct = value => numeric(value) ? `${(value * 100).toFixed(1)}%` : '需补';
const usd = value => numeric(value) ? `$${value.toFixed(2)}` : '需补';
const BORDER_EPSILON = 1e-8;
export const PRICE_ROUNDING_POLICY = Object.freeze({
  tick: 0.01, buyUpper: 'floor', sellLower: 'ceil', borderEpsilon: BORDER_EPSILON,
  description: '按$0.01取整：买入上限向下、卖出下限向上；显示门槛与实际决策共用该价格。'
});
const centBoundary = (value, direction) => {
  if (!numeric(value) || value < 0 || !numeric(value * 100)) return null;
  const cents = value * 100;
  return (direction === 'buy' ? Math.floor(cents + BORDER_EPSILON) : Math.ceil(cents - BORDER_EPSILON)) / 100;
};

function config(snapshot, overrides) {
  const inherited = record(snapshot?.decisionSettings) ? snapshot.decisionSettings : {};
  const settings = { ...DEFAULT_DECISION_SETTINGS, ...inherited, ...(record(overrides) ? overrides : {}) };
  const blockers = [];
  for (const key of ['targetUpsideTrial', 'targetUpsideCore', 'trimPremium', 'extremePremium']) {
    if (!numeric(settings[key]) || settings[key] < 0 || settings[key] > 5) blockers.push(`${key}须为0至5之间的小数比例`);
  }
  for (const key of ['qualityTrial', 'qualityCore']) {
    if (!numeric(settings[key]) || settings[key] < 0 || settings[key] > 100) blockers.push(`${key}须为0至100之间的质量门槛`);
  }
  for (const key of ['trialTrancheFraction', 'coreTrancheFraction', 'trimTrancheFraction', 'downtrendSpeedBudget']) {
    if (!numeric(settings[key]) || settings[key] < 0 || settings[key] > 1) blockers.push(`${key}须为0至1之间的预算比例`);
  }
  if (settings.targetUpsideCore < settings.targetUpsideTrial) blockers.push('核心预期回报门槛应不低于试仓门槛');
  if (settings.extremePremium < settings.trimPremium) blockers.push('极端溢价门槛应不低于减仓溢价门槛');
  if (settings.qualityCore < settings.qualityTrial) blockers.push('核心质量门槛应不低于试仓质量门槛');
  return { settings, blockers };
}

function valuation(snapshot) {
  const hasV2 = record(snapshot?.valuationV2);
  const cases = hasV2 ? snapshot.valuationV2.cases || {} : snapshot?.scenarios || {};
  const base = cases.base || {};
  const center = numeric(base.price) && base.price > 0 && base.invalid !== true ? base.price : null;
  const dcf = hasV2 ? base.methods?.dcf?.price : snapshot?.strictDCFPrice;
  return {
    center, base, hasV2,
    available: center !== null && snapshot?.valuationV2?.confidence?.level !== 'unavailable',
    normalBear: numeric(cases.bear?.price) ? cases.bear.price : null,
    normalBull: numeric(cases.bull?.price) ? cases.bull.price : null,
    stressPrice: numeric(cases.severeStress?.price) ? cases.severeStress.price : null,
    strictDCFPrice: numeric(dcf) && dcf > 0 ? dcf : null,
    confidence: snapshot?.valuationV2?.confidence || null
  };
}

/** Quality is evidence about the business; price and technical momentum are absent. */
export function deriveQuality(snapshot = {}) {
  const i = record(snapshot?.indicators) ? snapshot.indicators : {};
  const f = record(snapshot?.fundamentals) ? snapshot.fundamentals : {};
  const previous = record(f.previousFinancial) ? f.previousFinancial : {};
  const components = [], blockers = [], warnings = [];
  const add = (id, label, max, score, observations, explanation, complete, componentWarnings = []) => {
    components.push({ id, label, max, value: complete ? rounded(max * clamp(score)) : null,
      complete, observations, explanation, note: explanation, warnings: componentWarnings });
    if (!complete) blockers.push(`${label}缺少当时可见实绩`);
    warnings.push(...componentWarnings);
  };

  // Symmetric stress/expansion ranges are research definitions, not fitted cutoffs.
  const growthKnown = numeric(i.usdc30d) && numeric(i.usdc90d);
  add('supply', 'USDC供给质量', 30,
    growthKnown ? (scale(i.usdc30d, -0.05, 0.05) + scale(i.usdc90d, -0.10, 0.10)) / 2 : 0,
    [{ label: '30日净增长', value: i.usdc30d ?? null, unit: 'ratio' }, { label: '90日净增长', value: i.usdc90d ?? null, unit: 'ratio' }],
    '30日[-5%,+5%]与90日[-10%,+10%]分别线性计分，各占15分；只使用供给观察，不使用股价。', growthKnown);

  add('share', '竞争份额质量', 15, scale(i.marketShare90d, -0.01, 0.01) ?? 0,
    [{ label: '90日份额变化', value: i.marketShare90d ?? null, unit: 'ratio' }],
    '90日份额变化[-1pp,+1pp]线性计分；必须使用统一美元稳定币分母。', numeric(i.marketShare90d));

  const currentProfit = profit(f), previousProfit = profit(previous);
  const retentionKnown = numeric(f.reserveRetention) && f.reserveRetention >= 0 && f.reserveRetention <= 1;
  const profitGrowth = change(currentProfit, previousProfit);
  const comparable = !f.profitDefinition || !previous.profitDefinition || f.profitDefinition === previous.profitDefinition;
  const trendKnown = comparable && numeric(profitGrowth);
  const profitScore = !numeric(currentProfit) || currentProfit <= 0 ? 0
    : trendKnown ? scale(profitGrowth, -0.50, 0.50)
      : numeric(previousProfit) && previousProfit <= 0 && comparable ? 1 : 0.5;
  const earningsWarnings = !trendKnown && numeric(currentProfit) && currentProfit > 0
    ? ['无完整可比前季盈利趋势；只判断当前盈利符号，趋势部分按中性研究定义计分。'] : [];
  add('earnings', '留存与盈利质量', 30,
    retentionKnown ? (scale(f.reserveRetention, 0.20, 0.50) + profitScore) / 2 : 0,
    [{ label: '储备收入留存率', value: f.reserveRetention ?? null, unit: 'ratio' },
      { label: '季度盈利实绩', value: currentProfit, unit: 'USD' }, { label: '可比季度盈利变化', value: trendKnown ? profitGrowth : null, unit: 'ratio' }],
    '留存率[20%,50%]占15分；正盈利的可比季变化[-50%,+50%]占15分。盈利非正另触发风险复核。', retentionKnown && numeric(currentProfit), earningsWarnings);

  const knownRecurring = firstNumber(f.quarterRecurringOtherRevenue, f.recurringOtherRevenue);
  const previousRecurring = firstNumber(previous.quarterRecurringOtherRevenue, previous.recurringOtherRevenue);
  const currentOther = knownRecurring ?? (numeric(f.otherRevenue) ? f.otherRevenue - (numeric(f.nonRecurringOtherRevenue) ? f.nonRecurringOtherRevenue : 0) : null);
  const previousOther = previousRecurring ?? (numeric(previous.otherRevenue) ? previous.otherRevenue - (numeric(previous.nonRecurringOtherRevenue) ? previous.nonRecurringOtherRevenue : 0) : null);
  const currentOpex = firstNumber(f.quarterAdjustedOpex, f.quarterCashOperatingExpenses);
  const previousOpex = firstNumber(previous.quarterAdjustedOpex, previous.quarterCashOperatingExpenses);
  const coverage = numeric(currentOther) && currentOther >= 0 && numeric(currentOpex) && currentOpex > 0 ? currentOther / currentOpex : null;
  const previousCoverage = numeric(previousOther) && previousOther >= 0 && numeric(previousOpex) && previousOpex > 0 ? previousOther / previousOpex : null;
  const coverageGrowth = change(coverage, previousCoverage);
  const otherWarnings = knownRecurring === null && numeric(currentOther)
    ? ['未单列季度经常性其他收入：使用已披露other收入的会计代理，不能等同真实经常性业务；全年指引不替代实绩。'] : [];
  if (!numeric(coverageGrowth) && numeric(coverage)) otherWarnings.push('无完整前季收入/费用覆盖率，覆盖率趋势按中性研究定义计分。');
  const otherScore = numeric(coverage) ? (10 * scale(coverage, 0, 0.40) + 15 * (numeric(coverageGrowth) ? scale(coverageGrowth, -0.50, 0.50) : 0.5)) / 25 : 0;
  add('other-opex', '其他业务与费用质量', 25, otherScore,
    [{ label: knownRecurring === null ? '季度其他收入代理' : '季度经常性其他收入', value: currentOther, unit: 'USD' },
      { label: '季度调整后费用实绩', value: currentOpex, unit: 'USD' },
      { label: '其他收入/费用覆盖率', value: coverage, unit: 'ratio' }, { label: '覆盖率季变化', value: coverageGrowth, unit: 'ratio' }],
    '其他收入覆盖季度费用[0%,40%]占10分，覆盖率季变化[-50%,+50%]占15分；不把预测费用或全年收入指引当季度实绩。', numeric(coverage), otherWarnings);

  const complete = components.every(component => component.complete);
  const partialScore = rounded(components.reduce((sum, component) => sum + (component.value ?? 0), 0));
  return { score: complete ? partialScore : null, partialScore, complete, components, blockers, warnings,
    policy: '作者预设的质量描述，不是盈利概率；缺核心观察不补成0分或完整总分。' };
}

function timing(snapshot, settings) {
  const i = snapshot.indicators || {}, price = firstNumber(snapshot.observedPrice, snapshot.price);
  const longKnown = numeric(price) && numeric(i.ma20) && numeric(i.ma60);
  const shortKnown = numeric(i.ma5) && numeric(i.ma10);
  const downtrend = longKnown && price < i.ma20 && price < i.ma60 && i.ma20 <= i.ma60;
  const stabilized = numeric(price) && shortKnown && price >= i.ma5 && price >= i.ma10;
  const permitted = longKnown && (!downtrend || stabilized);
  const reasons = [];
  if (!longKnown) reasons.push('MA20/MA60缺失，无法确认战术时点');
  else if (downtrend && !shortKnown) reasons.push('下行中缺少MA5/MA10，企稳未能确认');
  else if (downtrend && !stabilized) reasons.push('价格低于MA20与MA60、MA20不高于MA60，且尚未收复MA5和MA10');
  else if (downtrend) reasons.push('长趋势仍下行，已收复MA5和MA10；只形成小额试仓条件');
  else if (stabilized) reasons.push('已收复MA5和MA10，未处于双均线下行条件');
  else reasons.push('长趋势未触发下行否决，短均线尚待进一步确认');
  if (numeric(i.rsi14)) reasons.push(`RSI ${i.rsi14.toFixed(1)}仅描述动量，不重复进入质量分`);
  if (numeric(i.atr14) && numeric(price) && price > 0) reasons.push(`ATR/收盘 ${pct(i.atr14 / price)}仅描述波动`);
  return { status: !longKnown ? '等待数据' : downtrend && !stabilized ? '下行未企稳' : stabilized ? '企稳确认' : '等待确认',
    downtrend, stabilized, trialPermitted: permitted, observedPrice: price,
    speedBudget: downtrend && !stabilized ? settings.downtrendSpeedBudget : 1,
    reasons, definition: '下行=收盘<MA20且收盘<MA60且MA20≤MA60；下行中企稳=收盘同时≥MA5与MA10。技术条件按当前完整日线冻结。' };
}

function assessment(snapshot, overrides) {
  snapshot = record(snapshot) ? snapshot : {};
  const { settings, blockers: configurationBlockers } = config(snapshot, overrides);
  const quality = deriveQuality(snapshot), observedTiming = timing(snapshot, settings), v = valuation(snapshot);
  const dataBlockers = Array.isArray(snapshot.dataBlockers) ? snapshot.dataBlockers.filter(value => typeof value === 'string')
    : Array.isArray(snapshot.blockers) ? snapshot.blockers.filter(value => typeof value === 'string' && !value.includes('暂停新增')) : ['缺少数据状态说明'];
  if (!numeric(snapshot.price) || snapshot.price <= 0) dataBlockers.push('当前价格缺失或无效');
  const f = snapshot.fundamentals || {}, i = snapshot.indicators || {};
  const currentProfit = profit(f);
  const forwardProfit = v.hasV2 ? firstNumber(v.base.forwardCashEBITDAProxy, v.base.years?.[0]?.cashEBITDAProxy) : firstNumber(v.base.forwardEBITDA);
  const operatingLoss = (numeric(currentProfit) && currentProfit <= 0) || (numeric(forwardProfit) && forwardProfit <= 0) || (!v.hasV2 && snapshot.hardExit === true);
  const eventVeto = settings.eventRisk === 'high' || settings.depeg === true;
  const severeFundamental = (numeric(i.usdc30d) && numeric(i.usdc90d) && i.usdc30d <= -0.05 && i.usdc90d <= -0.10)
    || (numeric(i.marketShare90d) && numeric(i.usdc30d) && i.marketShare90d <= -0.02 && i.usdc30d <= -0.03);
  const weakerFundamental = (numeric(i.usdc30d) && i.usdc30d < -0.03) || (numeric(i.marketShare90d) && i.marketShare90d < -0.01);
  const trendRisk = observedTiming.downtrend && !observedTiming.stabilized && weakerFundamental;
  const exitCause = operatingLoss || severeFundamental || trendRisk || settings.depeg === true;
  const tolerance = BORDER_EPSILON;
  const threshold = {
    trial: v.available && !configurationBlockers.length ? centBoundary(v.center / (1 + settings.targetUpsideTrial), 'buy') : null,
    core: v.available && !configurationBlockers.length ? centBoundary(v.center / (1 + settings.targetUpsideCore), 'buy') : null,
    trim: v.available && !configurationBlockers.length ? centBoundary(v.center * (1 + settings.trimPremium), 'sell') : null,
    extreme: v.available && !configurationBlockers.length ? centBoundary(v.center * (1 + settings.extremePremium), 'sell') : null
  };
  const row = (id, label, pass, current, required, kind = 'nonprice', explanation = '') => ({ id, label, pass: pass === true, current, required, kind, explanation });
  const dataRow = () => row('data', '数据可用', !dataBlockers.length, dataBlockers.length ? dataBlockers.join('；') : '已核验观察可用', '数据阻塞为空', 'data');
  const configRow = () => row('configuration', '研究门槛配置', !configurationBlockers.length, configurationBlockers.join('；') || '有效', '门槛有效且顺序一致');
  const valuationRow = () => row('valuation', '正常情景研究中枢可用', v.available, usd(v.center), '正常Base研究价格可用；压力情形不替代');
  const riskRow = () => row('risk', '新增风险否决', !eventVeto && !exitCause, eventVeto || exitCause ? '暂停新增' : '未触发', '事件风险非高/无脱锚/无经营破坏');
  const qualityRow = minimum => row('quality', '基本面质量', quality.complete && quality.score >= minimum,
    quality.complete ? `${quality.score.toFixed(1)} / 100` : quality.blockers.join('；'), `质量完整且≥${minimum}`);
  const priceRow = key => row('price', key === 'trial' ? '试仓预期回报' : key === 'core' ? '核心预期回报' : key === 'trim' ? '估值溢价减仓' : '极端估值溢价复核',
    numeric(threshold[key]) && (['trial', 'core'].includes(key) ? snapshot.price <= threshold[key] + tolerance : snapshot.price >= threshold[key] - tolerance),
    usd(snapshot.price), `${['trial', 'core'].includes(key) ? '≤' : '≥'}${usd(threshold[key])}`, 'price');
  const checklist = {
    trial: [dataRow(), configRow(), valuationRow(), riskRow(), qualityRow(settings.qualityTrial),
      row('timing', '战术企稳条件', observedTiming.trialPermitted, observedTiming.status, '下行中须收复MA5和MA10；否则等待企稳', 'timing', observedTiming.definition), priceRow('trial')],
    core: [dataRow(), configRow(), valuationRow(), riskRow(), qualityRow(settings.qualityCore), priceRow('core')],
    trim: [dataRow(), configRow(), valuationRow(), priceRow('trim')],
    extreme: [dataRow(), configRow(), valuationRow(), priceRow('extreme')],
    exit: [dataRow(), row('operating-risk', '独立风险复核', exitCause,
      operatingLoss ? '报告或前瞻经营盈利非正' : severeFundamental ? '供给与份额发生严重恶化' : trendRisk ? '基本面恶化叠加未企稳下行' : settings.depeg ? '脱锚风险' : '未触发',
      '经营盈利非正，或严重基本面恶化，或基本面恶化叠加下行，或脱锚')]
  };
  return { snapshot, settings, configurationBlockers, dataBlockers, quality, timing: observedTiming,
    valuation: v, threshold, checklist, operatingLoss, severeFundamental, trendRisk, exitCause, eventVeto };
}

export function decisionChecklist(snapshot = {}, settings = {}) {
  return assessment(snapshot, settings).checklist;
}

function evaluate(snapshot, overrides) {
  const a = assessment(snapshot, overrides), passed = rows => rows.every(row => row.pass);
  const trialGate = passed(a.checklist.trial), coreGate = passed(a.checklist.core);
  const trimGate = passed(a.checklist.trim), extremeGate = passed(a.checklist.extreme), exitGate = passed(a.checklist.exit);
  const tier = a.dataBlockers.length ? 'data-blocked' : exitGate ? 'exit-review' : extremeGate ? 'extreme' : trimGate ? 'trim' : coreGate ? 'core' : trialGate ? 'trial' : 'wait';
  const labels = { 'data-blocked': '数据不足', 'exit-review': '退出复核', extreme: '极端高估复核', trim: '估值减仓候选', core: '核心分批候选', trial: '小额试仓候选', wait: '等待条件' };
  const selected = tier === 'core' ? a.checklist.core : tier === 'trial' ? a.checklist.trial : tier === 'trim' ? a.checklist.trim : tier === 'extreme' ? a.checklist.extreme : tier === 'exit-review' ? a.checklist.exit : a.checklist.trial;
  const reasons = tier === 'wait' || tier === 'data-blocked'
    ? selected.filter(row => !row.pass).map(row => `${row.label}：${row.current}；需要${row.required}`)
    : [`${labels[tier]}；对应条件已通过`, ...(tier === 'core' && a.timing.speedBudget < 1 ? ['下行未企稳只降低长期分批额度，不再次否决估值路线'] : [])];
  const trancheFraction = tier === 'core' ? a.settings.coreTrancheFraction * a.timing.speedBudget
    : tier === 'trial' ? a.settings.trialTrancheFraction * a.timing.speedBudget
      : tier === 'trim' ? a.settings.trimTrancheFraction : 0;
  return { version: DECISION_VERSION, action: labels[tier], tier, buyGate: tier === 'core' || tier === 'trial',
    trialGate, coreGate, trimGate, extremeGate, exitGate, sellGate: trimGate || extremeGate || exitGate,
    quality: a.quality, timing: a.timing, speedBudget: a.timing.speedBudget, trancheFraction: rounded(trancheFraction),
    fullReview: tier === 'extreme' || tier === 'exit-review', operatingLoss: a.operatingLoss,
    checklist: a.checklist, reasons, dataBlockers: a.dataBlockers, configurationBlockers: a.configurationBlockers,
    targetUpside: tier === 'core' ? a.settings.targetUpsideCore : tier === 'trial' ? a.settings.targetUpsideTrial : null,
    expectedUpside: numeric(a.valuation.center) && numeric(snapshot?.price) && snapshot.price > 0 ? a.valuation.center / snapshot.price - 1 : null,
    valuationCenter: a.valuation.center, settings: a.settings, roundingPolicy: PRICE_ROUNDING_POLICY,
    buyScore: a.quality.score, sellScore: numeric(a.valuation.center) && numeric(snapshot?.price) ? rounded(100 * clamp((snapshot.price / a.valuation.center - 1) / Math.max(0.01, a.settings.extremePremium))) : null,
    scorePolicy: '买入摘要为基本面质量，减仓摘要为相对中枢溢价强度；两者不作为再次叠加的总分门槛。',
    warnings: [...a.quality.warnings, ...(a.valuation.confidence?.level === 'low' ? ['研究中枢置信度偏低；它不是统计置信区间，须复核方法分歧与覆盖。'] : [])] };
}

/** Same rule evaluator validates each boundary; all nonprice observations stay fixed. */
export function buildPriceMap(snapshot = {}, settings = {}) {
  const source = record(snapshot) ? snapshot : {}, a = assessment(source, settings);
  const result = { center: a.valuation.center, normalBear: a.valuation.normalBear, normalBull: a.valuation.normalBull,
    stressPrice: a.valuation.stressPrice, timingPolicy: 'observed-indicators-frozen',
    roundingPolicy: PRICE_ROUNDING_POLICY,
    policy: '价格条件按同一决策函数求解；技术与基本面冻结为今日观察，不预测未来RSI、趋势、成交或收入。',
    strictDCF: { fairValue: a.valuation.strictDCFPrice,
      price: numeric(a.valuation.strictDCFPrice) && !a.configurationBlockers.length ? centBoundary(a.valuation.strictDCFPrice / (1 + a.settings.targetUpsideCore), 'buy') : null,
      diagnostic: true, note: '严格DCF安全边际单独展示，不叠加否决战术或研究中枢路线。' } };
  for (const key of ['trial', 'core', 'trim', 'extreme']) {
    const price = a.threshold[key], rows = a.checklist[key], nonPrice = rows.filter(row => row.kind !== 'price');
    const nonPriceBlockers = nonPrice.filter(row => !row.pass).map(row => `${row.label}：${row.current}；需要${row.required}`);
    const probe = numeric(price) ? evaluate({ ...source, observedPrice: firstNumber(source.observedPrice, source.price), price }, a.settings) : null;
    const validated = probe ? probe[`${key}Gate`] : false;
    result[key] = { price, label: key === 'trial' ? '试仓价格条件' : key === 'core' ? '核心分批价格条件' : key === 'trim' ? '估值减仓价格条件' : '极端溢价复核条件',
      direction: ['trial', 'core'].includes(key) ? 'at-or-below' : 'at-or-above',
      priceConditionPass: rows.find(row => row.kind === 'price')?.pass === true,
      nonPricePass: nonPrice.every(row => row.pass), actionableAtPrice: validated === true,
      nonPriceBlockers, blockers: nonPriceBlockers,
      condition: numeric(price) ? `${['trial', 'core'].includes(key) ? '≤' : '≥'}${usd(price)}${nonPriceBlockers.length ? '；还需非价格条件通过' : '；今日其他条件已通过'}` : '研究中枢不可用，价格条件留空',
      budgetFraction: key === 'core' ? rounded(a.settings.coreTrancheFraction * a.timing.speedBudget) : key === 'trial' ? rounded(a.settings.trialTrancheFraction * a.timing.speedBudget) : key === 'trim' ? a.settings.trimTrancheFraction : 0,
      fullReview: key === 'extreme', normalCaseAnchor: 'base', researchRule: true };
  }
  return result;
}

export function evaluateDecisions(snapshot = {}, settings = {}) {
  const result = evaluate(snapshot, settings);
  return { ...result, priceMap: buildPriceMap(snapshot, result.settings) };
}
