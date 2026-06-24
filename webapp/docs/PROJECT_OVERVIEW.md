# NEM/WEM 电力市场数据平台 · 项目全貌

> 面向澳洲国家电力市场（NEM）与西澳市场（WEM）的实时数据监控与交易分析平台。
> 本文档面向技术经理与产品经理，涵盖产品定位、功能模块、技术架构与全部数据接口。

---

## 一、产品定位

面向澳洲电力市场的**实时数据监控与交易分析平台**，对标 ez2view / OpenNEM / Modo Energy 等专业终端。
核心能力：实时行情、发电监控、储能（BESS）与虚拟电厂（VPP）分析、竞价对标、模拟交易。

- 数据全部来自**公开免费**官方源，无需付费授权
- 全站**中英双语**
- 移动端待适配

---

## 二、功能模块（产品视角）— 7 个顶级页面

| 页面 | 核心功能 |
|---|---|
| **NEM** 总览 | 五区域实时电价/需求 KPI、地理地图（机组 + 联络线潮流 + MLF 热图）、燃料组合实时图、价格走势（含 K 线图、AEMO 预测、CPT 累积价格）、历史任意日查询、FCAS 矩阵、90 天热力图、天气关联、14 天充裕度预测（PASA） |
| **BESS** 储能 | 电池调度面板、模拟交易（Waratah 真实电池）、AEMO 竞价生命周期、智能建议报价、收益榜单（58 家真实电池排名）、合规记分卡 |
| **VPP** 虚拟电厂 | 投资组合管理、资源（EV/电池）调度、基线/分成/动态包络建模、同行 VPP 报价对标（AGL/ShineHub/EnelX 等 61 家真实聚合商） |
| **VPP-Calc** 收益模拟 | "要不要加入 VPP"测算:**C&I + 户用**两场景、三模式(A 零售ToU / B,C 现货)对比;真实 5 分钟现货估值、超高价日尾部价值;"套餐切换效应"与"VPP 提升"(B=套利+FCAS、C=自用+套利+FCAS)分开归因 |
| **BESS-Calc** 测算器 | 储能项目财务建模（LCOS/IRR/NPV/回收期）、历史回测、敏感性分析 |
| **Stations** 电站透视 | 全部 ~712 台机组档案：实时出力、MLF、排放强度、当日收益估算、出力×价格图、真实竞价带（买卖双向） |
| **News** 资讯 | 澳洲能源新闻聚合（4 家媒体 RSS，带原文链接）+ AEMO 官方公告流 |

---

## 三、技术架构（技术视角）

```
前端  React 18 + TypeScript 5 + Vite 5 + TailwindCSS + Recharts + d3-geo
      32 个组件，路由级懒加载，SSE 实时推送
        │  (REST + SSE, /api/*，共 67 个端点)
后端  FastAPI + Uvicorn + APScheduler + httpx
      11 个后台爬虫（定时调度），内存 TTL 缓存
        │
存储  SQLite (WAL 模式)，15 张表，约 4200 万行
部署  Docker 多阶段构建 + docker-compose（本地）/ Railway（生产）
```

**后端核心模块**：
`scheduler`（调度）· `db`（存储/迁移）· `registry`（元数据合并）·
`paper` + `vpp_settle` + `vpp_telemetry`（模拟交易引擎）·
`bess_finance` + `bess_backtest`（财务模型）· `routes/vpp_calc`（VPP 收益模拟,C&I+户用）· `cache`（缓存）

**技术栈版本**：React 18.3 · TypeScript 5.5 · Vite 5.3 · TailwindCSS 3.4 · Recharts 2.12 · d3-geo 3.1 / FastAPI ≥0.110 · Uvicorn ≥0.27 · APScheduler ≥3.10 · httpx ≥0.27

---

## 四、数据接口详细说明

> 全部公开免费，无需 API Key。轮询基准 `POLL_INTERVAL_SECONDS = 60s`。

### 1. AEMO NEMWeb · 调度出清 DispatchIS
- **URL**：`https://nemweb.com.au/Reports/Current/DispatchIS_Reports/`
- **格式**：ZIP→CSV（AEMO MMS 格式），文件名 `PUBLIC_DISPATCHIS_YYYYMMDDHHMM_*.zip`
- **AEMO 发布**：每 5 分钟 · **本系统抓取**：每 60 秒
- **解析 4 张 MMS 表 → 4 张库表**：

  | MMS 表 | 抽取字段 | 入库表 |
  |---|---|---|
  | `DISPATCH_PRICE` | RRP + 9 个 FCAS 价（RAISE/LOWER × 6SEC/60SEC/5MIN/REG/1SEC） | `nem_dispatch_price`（63 万行，14 个月） |
  | `DISPATCH_REGIONSUM` | TOTALDEMAND、可用发电、净联络线 | `nem_region_summary`（17 万） |
  | `DISPATCH_INTERCONNECTORRES` | 潮流 MW、进出口限额 | `nem_interconnector_flow`（20 万） |
  | `DISPATCH_CONSTRAINT` | 约束 ID、边际值、是否绑定 | `nem_dispatch_constraint`（16 万） |
- **用途**：首页 KPI、价格图、地图潮流、热力图、CPT 累积价格、约束叠加

### 2. AEMO NEMWeb · 机组遥测 Dispatch_SCADA
- **URL**：`.../Reports/Current/Dispatch_SCADA/` · `PUBLIC_DISPATCHSCADA_*.zip`
- **发布** 5 分钟 · **抓取** 60 秒
- **MMS 表** `DISPATCH_UNIT_SCADA` → 抽 `DUID` + `SCADAVALUE` → `nem_unit_dispatch`（192 万行，全部 ~510 台机组）
- **用途**：燃料组合实时图、电站透视出力曲线、BESS 收益榜

### 3. AEMO NEMWeb · 5 分钟预测 P5MIN + 预调度 PREDISPATCHIS
- **URL**：`.../P5_Reports/`（`PUBLIC_P5MIN_*`）、`.../PredispatchIS_Reports/`（`PUBLIC_PREDISPATCHIS_*`）
- **发布**：P5MIN 5 分钟 / PREDISPATCH 30 分钟 · **抓取** 5 分钟
- 抽 `INTERVAL_DATETIME`、`RUN_DATETIME`、`RRP`、`TOTALDEMAND` + FCAS → `nem_predispatch_price`
- **覆盖**：P5MIN 未来 ~1 小时；PREDISPATCH 未来 24–40 小时
- **用途**：价格图虚线预测段、建议报价

### 4. AEMO NEMWeb · 日前竞价 Next_Day_Offer
- **URL**：`.../Next_Day_Offer_Energy_SPARSE/`（+ FCAS、BIDMOVE_COMPLETE 三路）
- **发布**：每日约 12:30（次日盘） · **抓取** 5 分钟
- **两张 MMS 表**：
  - `BIDS_BIDDAYOFFER` → 10 档价格带 + 方向（GEN/LOAD） → `nem_bidday_offer`（2.5 万）
  - `BIDS_BIDOFFERPERIOD_SPARSE` → 逐区间申报量（稀疏展开成 5 分钟密集行） → `nem_bidper_offer`（**3700 万，保留 14 天**）
- **用途**：电站透视竞价带（买卖双向）、VPP 同行对标
- ⚠️ **当日竞价的唯一来源**（BIDMOVE 次日才补全）

### 5. AEMO NEMWeb · 短期充裕度 ST PASA
- **URL**：`.../Short_Term_PASA_Reports/` · `PUBLIC_STPASA_*.zip`
- **发布** 每小时 · **抓取** 30 分钟
- 抽 `DEMAND10/50/90`（需求三分位）、`AVAILABLEGENERATION`、LOR 储备等级 → `nem_st_pasa`（5760）
- **用途**：14 天供需充裕度页、LOR 缺电预警

### 6. AEMO NEMWeb · 屋顶光伏 ROOFTOP_PV
- **URL**：`.../Reports/CURRENT/ROOFTOP_PV/ACTUAL/`（+ ARCHIVE 回填）
- **发布** 30 分钟（卫星估算） · **抓取** 15 分钟
- MMS 表 `ROOFTOP_ACTUAL` → `REGIONID` + `POWER` → `nem_rooftop_pv`（4 千）
- **用途**：燃料组合中的屋顶光伏层（30→5 分钟插值）

### 7. AEMO NEMWeb · 市场公告 Market_Notice
- **URL**：`.../Reports/Current/Market_Notice/` · 纯文本 `NEMITWEB1_MKTNOTICE_YYYYMMDD.R<id>`
- **发布** 事件驱动 · **抓取** 5 分钟
- 正则抽取：公告 ID、类型、创建时间、外部引用、正文 → `nem_market_notice`（保留 500 条）
- **用途**：全局滚动条 + 资讯页公告区（类型已中文化）

### 8. AEMO MMSDM 归档 · 注册表（月度）
- **URL**：`https://nemweb.com.au/Data_Archive/Wholesale_Electricity/MMSDM/{年}/{月}/...`（URL 含双重编码 `%2523`）
- **发布** 月度 · **抓取** 每周（自动回退找最新可用月）
- **5 表联查**（`PARTICIPANT_REGISTRATION_*`）：

  | 表 | 提供 |
  |---|---|
  | DUDETAILSUMMARY | DUID→区域、调度类型、损失因子（TLF）、有效期 |
  | DUDETAIL | 注册容量/最大容量 |
  | DUALLOC | DUID→机组组 GENSETID |
  | GENUNITS | 燃料类型（CO2E_ENERGY_SOURCE）、排放因子 |
  | STATION | 电站名称 |
- → `nem_facility_registry`（712 现役机组）+ `nem_mlf`（1051，损失因子）
- **用途**：权威元数据底座——修正手工 DUID 列表、电站清单、MLF 热图、所有"全量机组"功能

### 9. AEMO WA · 西澳参考价 WEMDE
- **URL**：`https://data.wa.aemo.com.au/public/market-data/wemde/referenceTradingPrice/current/`
- **格式**：**JSON**（非 MMS） · **发布** 日更 · **抓取** 5 分钟
- 抽 `tradingInterval` + `referenceTradingPrice` → `wem_price`（1679）
- **用途**：WEM 区域价格图

### 10. Open-Meteo · 天气（实时调用，不入库）
- **URL**：`https://api.open-meteo.com/v1/forecast`
- 五区首府坐标，抽气温/体感/光照/风速风向，过去 6 天 + 当天（168 小时）
- **30 分钟内存缓存**，不落库
- **用途**：天气页，关联风光出力与电价信号

### 11. 澳洲能源媒体 RSS · 新闻
- **URL**（4 路 RSS）：
  - `https://reneweconomy.com.au/feed/`
  - `https://www.pv-magazine-australia.com/feed/`
  - `https://www.energymagazine.com.au/feed/`
  - `https://thedriven.io/feed/`
- **抓取** 每小时，XML 解析抽标题/链接/作者/时间/摘要/配图/分类 → `nem_news`（保留 200 条）
- **用途**：资讯页新闻卡片，带原文链接

### 数据接口汇总表

| # | 提供方 | 接口 | 格式 | 发布 | 抓取 | 入库表（行数） |
|---|---|---|---|---|---|---|
| 1 | AEMO NEMWeb | DispatchIS | ZIP/CSV | 5min | 60s | dispatch_price 等 4 表 |
| 2 | AEMO NEMWeb | Dispatch_SCADA | ZIP/CSV | 5min | 60s | unit_dispatch（192 万） |
| 3 | AEMO NEMWeb | P5MIN/PREDISPATCH | ZIP/CSV | 5/30min | 5min | predispatch_price |
| 4 | AEMO NEMWeb | Next_Day_Offer | ZIP/CSV | 日 | 5min | bidday/bidper（3700 万） |
| 5 | AEMO NEMWeb | ST PASA | ZIP/CSV | 1h | 30min | st_pasa |
| 6 | AEMO NEMWeb | Rooftop PV | ZIP/CSV | 30min | 15min | rooftop_pv |
| 7 | AEMO NEMWeb | Market Notice | TXT | 事件 | 5min | market_notice |
| 8 | AEMO MMSDM | 注册表 5 表 | ZIP/CSV | 月 | 周 | facility_registry/mlf |
| 9 | AEMO WA | WEMDE | JSON | 日 | 5min | wem_price |
| 10 | Open-Meteo | 天气 | JSON | — | 实时 | （缓存，不落库） |
| 11 | 能源媒体 | RSS×4 | XML | — | 1h | news |

---

## 五、数据规模

| 数据 | 量级 | 时间跨度 |
|---|---|---|
| 5 分钟电价 | 63 万行 | 2025-04 至今（14 个月） |
| 机组出力 SCADA | 192 万行 | 近 1 个月（全量 510 机组） |
| 竞价申报 | 3700 万行 | 保留 14 天 |
| 注册机组元数据 | 712 台 | 月度刷新 |
| 损失因子 MLF | 1051 条 | 财年制 |

---

## 六、需要管理层知晓的几点（重要）

### 1. 真实 vs 模拟的边界
- ✅ **真实数据**：所有价格、出力、竞价、注册信息、公告、新闻——直接来自 AEMO/媒体官方源
- ⚠️ **模拟数据**：BESS/VPP 的**模拟交易盘**（paper trading）和 VPP 资源遥测（EV 可用率/电池 SoC）是演示用模拟器，非真实运营数据。当前界面**未明确标注 DEMO**，公开发布前建议加标识
- 🔎 **预测定位**：页面预测线与 `/api/forecast` 均为 **AEMO 官方预调度**（P5MIN / PREDISPATCH）。仓库 `/src/` 下的 GNN-Transformer 为**独立离线研究管道，未接入线上**，勿混淆。

### 2. 运维风险
竞价表（`nem_bidper_offer`）已达 3700 万行（SQLite），增长快；建议尽快定保留策略或迁移 Postgres。

### 3. 待办（已识别未做）
价格告警推送、碳排放强度、移动端适配、用户认证/限流、自动化测试、数据备份策略、新闻/公告正文翻译（目前保留英文原文）。

### 4. 合规
使用 AEMO 公开数据需注明来源（attribution），页面尚未添加署名。

---

*文档生成于项目当前状态，数据量级为快照值。*
