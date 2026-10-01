# StableMonitor

稳定币行业仪表盘与 CRCL 买卖纪律研究台。

- [行业仪表盘](https://stablemonitor.github.io/stablemonitor/)
- [CRCL 买卖纪律](https://stablemonitor.github.io/stablemonitor/crcl.html)
- [完整方法说明](METHODOLOGY.md)

`index.html` 优先展示同站当前CRCL摘要，即时稳定币榜单独立读取DefiLlama，失败时保留有日期的供给缓存；五月静态研究资料收起归档。`crcl.html` 展示完整研究台：持仓视角、共享条件清单、双储备模型、互斥薪酬口径、反向估值、情景、预算、历史价带及公平回放。

当前模型v1.1，历史重建基线v1.0。版本差异明确展示；研究假设可在浏览器保存，账户为空不生成个人金额，演示账户明确标识。

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
- `assets/crcl-usable.js`、`assets/crcl-usable.css`：持仓解释、逐项条件、反算、预算与公平回放界面。
- `assets/home-current.js`：同站当前摘要、独立榜单故障降级。
- `scripts/update-data.mjs`、`scripts/market-data.mjs`：严格源解析、时区、历史保护、重试、失败缓存与原子写入。
- `tests/*.test.mjs`：经济单位、反算代回、缺失、时点、预算、SBC、基准资金及采集边界验证。

情景与阈值未经样本外验证。历史没有入场时，现金组合的零回报不能证明策略有效。方法灵感来自[子琦的 CRCL 看板](https://crcl.seanzhao.ai/)，计算与界面独立实现。
