// The homepage evaluates one latest snapshot using the research page's default
// assumptions. It never replays history or restores private portfolio settings.
const $ = id => document.getElementById(id);
const finite = n => typeof n === 'number' && Number.isFinite(n);
const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const num = (n, d = 2) => finite(n) ? n.toLocaleString('en-US', {minimumFractionDigits:d, maximumFractionDigits:d}) : '需补';
const money = n => finite(n) ? `$${num(n)}` : '需补';
const amount = n => finite(n) ? Math.abs(n) >= 1e9 ? `$${num(n / 1e9)}B` : `$${num(n / 1e6, 1)}M` : '需补';
const pct = n => finite(n) ? `${num(n * 100, 2)}%` : '需补';
const date = value => {
  if (typeof value !== 'string') return '日期需补';
  if (!value.includes('T')) return validDay(value) ? value : '日期需补';
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return '日期需补';
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {timeZone:'Asia/Shanghai', year:'numeric', month:'2-digit', day:'2-digit'}).formatToParts(parsed).map(row => [row.type,row.value]));
  return parts.year + '-' + parts.month + '-' + parts.day;
};
const validDay = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const previousDay = value => validDay(value) ? new Date(Date.parse(`${value}T00:00:00Z`) - 86400000).toISOString().slice(0, 10) : null;
const currentEasternDate = () => {
  const parts = new Intl.DateTimeFormat('en-US', {timeZone:'America/New_York', year:'numeric', month:'2-digit', day:'2-digit'}).formatToParts(new Date());
  const part = key => parts.find(row => row.type === key)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
};
const latestObservation = (rows, cutoff) => Array.isArray(rows) ? rows.filter(row => row && validDay(row.date) && row.date <= cutoff).sort((a, b) => a.date.localeCompare(b.date)).at(-1) : null;
const metric = (label, value, note) => `<article class="current-metric"><span>${esc(label)}</span><strong>${esc(value)}</strong><small>${esc(note)}</small></article>`;
let cachedSupply = null;

function captureSupplyCache(data, asOf) {
  const row = latestObservation(data.usdc, previousDay(asOf));
  if (row && finite(row.usdc) && row.usdc > 0 && finite(row.totalStablecoins) && row.totalStablecoins > 0) {
    cachedSupply = {date:row.date, nominal:row.usdc, usdcUSD:finite(row.usdcUSD) ? row.usdcUSD : null, total:row.totalStablecoins, fetchedAt:data.metadata?.sources?.usdc?.fetchedAt || data.metadata?.generatedAt};
  }
  renderRankingFallback();
}

async function fetchJSON(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, {cache:'no-cache', signal:controller.signal});
    if (!response.ok) throw new Error(`${url.includes('financials') ? '财报' : '行情'}快照读取失败（HTTP ${response.status}）`);
    const value = await response.json();
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('快照根节点不完整');
    return value;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('同站快照请求超时');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function renderRankingFallback() {
  const state = window.stableRankingState || {state:'loading'};
  if (state.state === 'ready') return;
  if (!cachedSupply) {
    if (state.state === 'error') {
      $('ranking-mini-status').textContent = '即时榜单与供给缓存均需补';
      $('data-status').textContent = '即时榜单失败；同站供给缓存也未取得有效值。CRCL 模型状态见上方。';
      $('ranking-update-time').textContent = state.message || '外部榜单不可用';
      for (const id of ['kpi-total', 'kpi-usdt-share', 'kpi-usdc-share', 'kpi-hhi']) $(id).textContent = '需补';
      $('kpi-total-sub').textContent = '缺少有效快照';
      $('stable-table').innerHTML = '<tr><td colspan="9">即时榜单与同站供给快照均不可用，未用旧固定数值填补。</td></tr>';
    }
    return;
  }
  const c = cachedSupply;
  const stateText = state.state === 'error' ? '即时榜单失败' : '即时榜单正在拉取';
  $('ranking-mini-status').textContent = `${stateText} · 展示同站缓存`;
  $('data-status').textContent = `${stateText}；保留同站供给缓存（截至 ${c.date}）。下表不是完整 Top 10，未冒充即时榜单。`;
  $('data-status').classList.add('warn');
  $('ranking-update-time').textContent = `${state.message ? state.message + '；' : ''}缓存源：DefiLlama；采集 ${date(c.fetchedAt)}；供给美元金额为 USD 市值口径。`;
  $('kpi-total-label').textContent = '美元稳定币总量 · 美元市值缓存';
  $('kpi-total').textContent = amount(c.total);
  $('kpi-total-sub').textContent = `截至 ${c.date}；完整榜单待恢复`;
  $('kpi-usdc-share').textContent = finite(c.usdcUSD) && c.total > 0 ? pct(c.usdcUSD / c.total) : '需补';
  $('kpi-usdt-share').textContent = '需补';
  $('kpi-hhi').textContent = '需补';
  $('stable-table').innerHTML = `<tr><td class="c">缓存</td><td class="l"><strong>USD Coin · USDC</strong><br><small>截至 ${esc(c.date)}</small></td><td class="r">${esc(amount(c.nominal))}<br><small>名义供给；美元市值 ${esc(amount(c.usdcUSD))}</small></td><td class="r">需补</td><td class="r">需补</td><td class="r">需补</td><td class="r">需补</td><td class="r">${esc(c.total > 0 && finite(c.usdcUSD) ? pct(c.usdcUSD / c.total) : '需补')}<br><small>美元市值口径</small></td><td class="c">法币储备</td></tr>`;
  $('insight-box').textContent = '当前保留的是可核对日期的同站 USDC 与美元总量缓存。完整榜单、USDT 份额、HHI 与榜单变动仍需补；外部榜单故障不会自动否定上方 CRCL 摘要。';
}
window.addEventListener('stable-ranking-error', renderRankingFallback);

function mergeFinancials(market, financial) {
  const merged = {...market};
  merged.financials = Array.isArray(financial?.financials) ? financial.financials : [];
  merged.shares = Array.isArray(market.shares) && market.shares.length ? market.shares : Array.isArray(financial?.shares) ? financial.shares : [];
  merged.latestOfficialSensitivity = financial?.latestOfficialSensitivity;
  merged.financialMetadata = financial?.metadata;
  const last = merged.financials.filter(row => row && validDay(row.availableAt)).sort((a, b) => a.availableAt.localeCompare(b.availableAt)).at(-1);
  merged.metadata = {...market.metadata, sources:{...market.metadata?.sources, financials:{status:last?.verified === true ? 'verified' : 'unavailable', asOf:last?.periodEnd, fetchedAt:financial?.metadata?.asOfDate, url:last?.sourceUrl}}};
  return merged;
}

function renderSummary(snapshot, data, financialError, modelVersion, describe) {
  const l = snapshot;
  const f = l.fundamentals || {};
  const closeDate = finite(l.price) ? date(l.date) : '需补';
  const asOf = validDay(l.date) ? l.date : currentEasternDate();
  const cutoff = previousDay(asOf);
  const chain = latestObservation(data.usdc, cutoff);
  const rate = latestObservation(data.rates, cutoff);
  const nominal = finite(f.currentUSDC) ? f.currentUSDC : chain?.usdc;
  const usdcUSD = finite(f.currentUSDCUSD) ? f.currentUSDCUSD : chain?.usdcUSD;
  const total = chain?.totalStablecoins;
  const sofr = finite(f.currentSOFR) ? f.currentSOFR : rate?.sofr;
  const chainDate = date(f.usdcAsOf || chain?.date);
  const rateDate = date(f.rateAsOf || rate?.date);
  const share = finite(usdcUSD) && total > 0 ? usdcUSD / total : null;
  const financial = Array.isArray(data.financials) ? data.financials.filter(row => row && validDay(row.availableAt) && row.availableAt < asOf).sort((a, b) => a.availableAt.localeCompare(b.availableAt)).at(-1) : null;
  const period = f.period || financial?.period || '需补';
  const financialDate = date(f.financialAvailableAt || financial?.availableAt);
  const conclusion = describe(l, 'flat', null);
  const dataBlocked = (l.dataBlockers || l.blockers || []).some(text => !text.includes('暂停新增')) || Boolean(financialError);
  const header = dataBlocked ? `CRCL 快照已读取，当前判断受数据限制 · 收盘 ${closeDate}` : `CRCL 同站快照 · 已完成收盘 ${closeDate}`;
  $('current-mini-status').textContent = header;
  $('home-current-status').textContent = `${header}；供给 ${chainDate}；SOFR ${rateDate}；缓存采集（北京时间）${date(data.metadata?.generatedAt)}。这些是有日期的快照，非盘中报价。`;
  $('home-current-status').classList.toggle('warn', dataBlocked);
  $('home-current-metrics').innerHTML = [
    metric('CRCL 已完成收盘价', money(l.price), `交易日 ${closeDate} · Yahoo Finance 日线`),
    metric('USDC 名义供给', amount(nominal), `观测 ${chainDate} · 估值储备规模使用名义单位`),
    metric('USDC 美元市值 / 份额', amount(usdcUSD), `美元市值份额 ${pct(share)} · 同源美元口径`),
    metric('美元稳定币总量', amount(total), `观测 ${chainDate} · 仅美元锚定币 USD 市值`),
    metric('SOFR / 储备收益率代理', pct(sofr), `观测 ${rateDate} · 校准储备代理 ${pct(f.currentReserveYield)}`),
    metric('最新已公开财报', period, `期末 ${date(f.financialPeriodEnd || financial?.periodEnd)} · 披露 ${financialDate}`),
    metric('Base 多期研究中枢', money(l.scenarios?.base?.price), `Bear ${money(l.scenarios?.bear?.price)} / Bull ${money(l.scenarios?.bull?.price)} · 默认假设`),
    metric('小仓试探价格条件', money(l.positionBands?.buyBelow), `还需基本面质量、试仓企稳及风险条件通过，不叠加旧70分`)
  ].join('');
  $('home-current-decision').textContent = financialError ? '等待有效数据' : conclusion.title;
  $('home-current-reason').textContent = financialError ? `${financialError}。已读取的行情可查看，财报恢复前暂停当前买卖判断。` : conclusion.reason;
  const blockers = (l.blockers || []).filter(Boolean);
  const gaps = (l.checklist?.trial || l.checklist?.buy || []).filter(row => row.pass !== true).map(row => row.label);
  $('home-current-proof').textContent = `模型 ${modelVersion || '版本需补'} · ${l.action || '数据不足'}；基本面质量 ${finite(l.buyScore) ? num(l.buyScore, 0) + '/100' : '需补'}。${blockers.length ? '数据 / 风险限制：' + blockers.slice(0, 5).join('；') + '。' : '尚未通过的买入条件：' + (gaps.join('、') || '无') + '。'}摘要采用研究台默认参数及未持仓视角；你在研究台修改参数或持仓视角后，结论可能不同。价格门槛不等于自动成交点。`;
  if (chain && finite(nominal) && nominal > 0 && finite(total) && total > 0) cachedSupply = {date:chainDate, nominal, usdcUSD, total, fetchedAt:data.metadata?.sources?.usdc?.fetchedAt || data.metadata?.generatedAt};
  renderRankingFallback();
}

function failSummary(error) {
  $('current-mini-status').textContent = 'CRCL 同站快照读取失败';
  $('home-current-status').textContent = `当前摘要不可用：${error.message || '快照或模型未载入'}。未用旧研究数据替代当前判断。`;
  $('home-current-status').classList.add('warn');
  $('home-current-decision').textContent = '等待有效数据';
  $('home-current-reason').textContent = '恢复有效行情、财报与模型输入后才产生条件判断。可打开研究台查看其独立数据状态。';
  renderRankingFallback();
}

async function start() {
  const results = await Promise.allSettled([
    fetchJSON('./data/market-data.json'),
    fetchJSON('./data/financials.json'),
    Promise.all([import('./crcl-research-v2.js'), import('./crcl-usable.js')])
  ]);
  const [marketResult, financialResult, moduleResult] = results;
  if (marketResult.status === 'rejected') throw marketResult.reason;
  captureSupplyCache(marketResult.value, currentEasternDate());
  if (moduleResult.status === 'rejected') throw new Error('当前研究模型未载入，请稍后刷新');
  const market = marketResult.value;
  const financial = financialResult.status === 'fulfilled' ? financialResult.value : null;
  const financialError = financialResult.status === 'rejected' ? financialResult.reason.message : null;
  const data = mergeFinancials(market, financial);
  const [Model, {explainDecision}] = moduleResult.value;
  data.valuationContext = await fetchJSON('./data/valuation-context.json');
  const normalized = Model.normalizeData(data);
  const today = currentEasternDate();
  const latestDate = normalized.prices.CRCL.filter(row => row.date <= today).at(-1)?.date || today;
  const sourceAsOf = new Date().toISOString().slice(0, 10);
  const snapshot = Model.evaluateSnapshot(normalized, latestDate, {}, {normalized:true, latest:true, asOf:sourceAsOf, diagnostics:false});
  renderSummary(snapshot, normalized, financialError, Model.MODEL_VERSION, explainDecision);
}
start().catch(failSummary);
