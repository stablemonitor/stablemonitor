# StableMonitor

稳定币行业仪表盘与 CRCL 买卖纪律研究台。

- [行业仪表盘](https://stablemonitor.github.io/stablemonitor/)
- [CRCL 买卖纪律](https://stablemonitor.github.io/stablemonitor/crcl.html)
- [完整方法说明](METHODOLOGY.md)

`index.html` 的供应榜单读取 DefiLlama；其五月静态研究页明确标注历史快照。`crcl.html` 读取经过核验的财务快照与独立更新的市场历史数据，展示情景价格、买卖候选、压力测试、指标和资金约束回放。

## 本地查看

在仓库根目录启动任意静态 HTTP 服务，例如 `python3 -m http.server 8768`，打开 `http://localhost:8768/crcl.html`。直接双击本地文件可能受到浏览器模块和数据加载限制。

## 数据与验证

需要 Node.js 22 或以上；无第三方运行依赖。

```sh
npm test
npm run update-data
```

市场快照写入 `data/market-data.json`，失败状态、旧缓存和日期均保留。GitHub Actions 每个工作日刷新并提交市场数据，在同一流程通过官方 Pages 部署发布；代码推送也触发部署。财报不由自动任务臆测，需要新财报发布后更新 `data/financials.json` 中的来源、公布时间、字段状态与股数快照，再运行测试。

## 计算与展示

- `assets/crcl-model.js`：独立纯计算、信息可用时点、技术指标、情景、评分及回放。
- `assets/crcl-dashboard.js`、`assets/crcl.css`：图表、情景控制、CSV导出、响应式界面。
- `scripts/update-data.mjs`：Yahoo/DefiLlama/纽约联储数据采集，排除未完成美股日线。
- `tests/model.test.mjs`：单位、敏感性、数据缺失、时点和资金约束验证。

情景与阈值未经样本外验证。历史没有入场时，现金组合的零回报不能证明策略有效。方法灵感来自[子琦的 CRCL 看板](https://crcl.seanzhao.ai/)，计算与界面独立实现。
