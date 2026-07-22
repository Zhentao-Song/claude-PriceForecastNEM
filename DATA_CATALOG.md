# NEM/WEM Price Forecast 项目数据目录

审计日期：2026-07-13  
审计范围：当前本地工作区中的数据下载代码、原始数据、缓存/加工数据、实时应用数据库、外部接口、静态参考数据、VPP 商务测算文件及未被程序引用的数据文件。

## 1. 口径说明

本目录将项目数据分成五类：

- **实采数据**：从 AEMO、WEMDE、Open-Meteo、ASX、RSS、Amber 或 OpenStreetMap 获取。
- **加工数据**：由实采数据合并、聚合、特征工程或模型计算生成。
- **静态参考数据**：人工整理后直接写在 Python/TypeScript/GeoJSON 中。
- **模拟/业务数据**：纸面交易、VPP 演示资源、商务测算假设和模拟结算结果。
- **未引用/来源不完整数据**：文件存在，但当前代码没有读取，或仓库没有保存完整来源链路。

“来源”描述的是当前代码或文件中记录的来源，并不代表本次审计重新验证了外部接口的在线可用性。

## 2. 总体结论

1. 根目录离线价格预测模型当前实际使用的外部原始数据只有 AEMO 的 `DISPATCHPRICE` 和 `DISPATCHREGIONSUM`。
2. 当前离线训练集没有 P5MIN：训练日志记录 `nemseer` 未安装，因此 P5MIN 被跳过。
3. `webapp` 设计的数据范围更广，包括 NEM 实时价格、FCAS、SCADA、P5MIN、PREDISPATCH、竞价、PASA、屋顶光伏、设施注册、MLF、市场通知、WEM、天气、ASX 期货、Amber 和新闻。
4. 当前本地 `market.sqlite3` 基本没有实时市场数据；只有静态 MLF 和演示账户/资源。
5. 本地原始数据、Parquet、SQLite、模型权重和日志都被 `.gitignore` 排除，不会随 Git 自动同步。
6. 地图州界的直接下载地址已确认；输电线和变电站来自 OpenStreetMap Overpass，但生成合并文件的一次性脚本没有保存在仓库内。
7. `nem-substations.geojson` 只有 1 个点，是失败/不完整的全 NEM 变电站产物，不能作为全网变电站数据使用。
8. 发电机、互联线、MLF 种子、城市锚点和天气代表坐标均含人工整理成分；VPP 资源及纸面交易账户是项目模拟数据，不是外部实采数据。

## 3. 外部数据源总表

| ID | 来源 | 获取地址/方式 | 来数形式 | 主要数据 | 项目落地位置 | 当前状态 |
|---|---|---|---|---|---|---|
| DS-01 | AEMO NEMWeb 月度 MMSDM | `https://nemweb.com.au/Data_Archive/Wholesale_Electricity/MMSDM/`，NEMOSIS 为主、`nemdata` 为代码中的备用下载器 | ZIP → MMS CSV → Feather/Parquet | `DISPATCHPRICE`、`DISPATCHREGIONSUM` | `data/raw/`、`data/cache/`、`data/processed/` | 已落地并用于离线模型 |
| DS-02 | AEMO DispatchIS Current | `https://nemweb.com.au/Reports/Current/DispatchIS_Reports/` | ZIP 内 MMS CSV | 能源/FCAS 价格、需求、互联线、约束 | SQLite 多张 `nem_*` 表 | 代码已接入；本地库当前 0 行 |
| DS-03 | AEMO DispatchIS Archive | `https://nemweb.com.au/Reports/Archive/DispatchIS_Reports/` | 每日外层 ZIP → 288 个 5 分钟 ZIP → MMS CSV | 历史价格、区域摘要、互联线、约束 | 同 DS-02 | 代码用于 90 天回填；本地库当前未填充 |
| DS-04 | AEMO Dispatch SCADA | `https://nemweb.com.au/Reports/Current/Dispatch_SCADA/` | ZIP 内 MMS CSV | 所有 DUID 的 5 分钟实际出力 | `nem_unit_dispatch` | 代码已接入；本地库当前 0 行 |
| DS-05 | AEMO P5MIN | `https://nemweb.com.au/Reports/Current/P5_Reports/` | ZIP 内 MMS CSV | 未来约 55 分钟、5 分钟粒度的能源/FCAS价格和需求预测 | `nem_predispatch_price`，或离线 `p5min_forecasts.parquet` | Webapp 已接入；离线文件未生成 |
| DS-06 | AEMO PREDISPATCHIS | `https://nemweb.com.au/Reports/Current/PredispatchIS_Reports/` | ZIP 内 MMS CSV | 未来约 24–40 小时、30 分钟粒度的价格/需求预测 | `nem_predispatch_price` | 代码已接入；本地库当前 0 行 |
| DS-07 | AEMO 竞价文件 | `Next_Day_Offer_Energy_SPARSE`、`Next_Day_Offer_FCAS_SPARSE`、`Bidmove_Complete` | ZIP 内 MMS CSV | 10 档报价、档位容量、MaxAvail、爬坡、再报价原因 | `nem_bidday_offer`、`nem_bidper_offer` | 代码已接入；本地库当前 0 行 |
| DS-08 | AEMO ST PASA | `https://nemweb.com.au/Reports/Current/Short_Term_PASA_Reports/` | ZIP 内 MMS CSV | 需求 P10/P50/P90、可用发电、储备/LOR | `nem_st_pasa` | 代码已接入；本地库当前 0 行 |
| DS-09 | AEMO Rooftop PV | `https://nemweb.com.au/Reports/CURRENT/ROOFTOP_PV/ACTUAL/` 及 Archive | ZIP 内 MMS CSV | 各 NEM 区域 30 分钟屋顶光伏实际出力 | `nem_rooftop_pv` | 代码已接入；当前本地库尚无该表/数据 |
| DS-10 | AEMO Participant Registration | MMSDM 月度 `DUDETAILSUMMARY`、`DUDETAIL`、`DUALLOC`、`GENUNITS`、`STATION` | 5 个 ZIP 内 MMS CSV，代码拼接 | DUID、站点、容量、燃料、调度类别、TLF、排放 | `nem_facility_registry`、`nem_mlf` | 代码已接入；当前本地库只有静态 MLF 种子 |
| DS-11 | AEMO Market Notices | `https://nemweb.com.au/Reports/Current/Market_Notice/` | 固定格式纯文本 | LOR、干预、CPT/APC、约束重分类等通知 | `nem_market_notice` | 代码已接入；当前本地库尚无该表/数据 |
| DS-12 | AEMO 年度 Loss Factor Report | [Marginal Loss Factors for the 2025-26 Financial Year（PDF）](https://www.aemo.com.au/-/media/files/electricity/nem/security_and_reliability/loss_factors_and_regional_boundaries/2025-26-marginal-loss-factors/marginal-loss-factors-for-the-2025-26-fin-year.pdf) | PDF → 人工录入 Python 列表 | FY2025-26 MLF；容量、燃料和坐标为附加人工字段 | `nem_mlf` 静态种子 | 当前本地有 73 行；未保存提取脚本或逐行引用，尚不能逐项证明与 PDF 一致 |
| DS-13 | AEMO WEMDE | `https://data.wa.aemo.com.au/public/market-data/wemde/referenceTradingPrice/current/` | JSON | 西澳 WEM Reference Trading Price | `wem_price` | 代码已接入；本地库当前 0 行 |
| DS-14 | Open-Meteo | Forecast API 与 Archive API | JSON | 温度、体感温度、风、太阳辐射、降水、天气代码 | API 即时返回；`weather_cache` | 代码已接入；当前本地库没有缓存表/数据 |
| DS-15 | ASX Energy | `https://www.asx.com.au/data/futures/reports/EODWebMarketSummary{date}SFT.htm` | HTML 表格 | 四州季度基荷电力期货 OHLC、结算、持仓、成交量 | API 运行时返回，不落库 | 当前工作区新增代码，未形成历史库 |
| DS-16 | Amber Electric API | `https://api.amber.com.au/v1` | 鉴权 JSON API | 客户站点、30 分钟 spot price forecast | 运行时预测曲线，不落库 | 可选；本机 `AMBER_API_TOKEN` 未配置 |
| DS-17 | 澳洲能源新闻网站 | RenewEconomy、pv-magazine AU、Energy Magazine、The Driven | RSS/XML | 标题、作者、发布时间、摘要、图片、分类、原文 URL | `nem_news` | 代码已接入；当前本地库尚无该表/数据 |
| DS-18 | OpenStreetMap Overpass | `https://overpass.openstreetmap.fr/api/interpreter`、`https://overpass-api.de/api/interpreter`、`https://overpass.kumi.systems/api/interpreter` | Overpass JSON → 一次性脚本清洗/合并 → GeoJSON | 132/220/275/330/500kV 输电线和变电站 | `nsw-*.geojson`、`nem-*.geojson` | 来源和查询条件已确认；原始响应及最终合并脚本未保存，`nem-substations` 明显不完整 |
| DS-19 | 各公司官网/ARENA/行业媒体 | 工作簿备注写明公司官网、ARENA、pv magazine、Energy-Storage.News 等 | 人工研究后录入 XLSX | VPP 竞品、规模、服务、收费模式 | `VPP竞品对比.xlsx` | 有摘要来源，缺少逐行 URL |
| DS-20 | GeoJson-Data GitHub 仓库 | [原始精简州界文件](https://raw.githubusercontent.com/tonywr71/GeoJson-Data/master/australian-states.min.geojson)；[仓库主页](https://github.com/tonywr71/GeoJson-Data) | GeoJSON 直接下载/复制 | 澳洲 8 个州及领地边界、州代码、州名 | `aus-states.geojson` | 直接下载地址已确认；上游仓库没有清楚说明其更早的政府原始来源和许可 |

## 4. AEMO 月度原始数据

### 4.1 本地原始文件

目录：`data/raw/`，约 186 MB。

- 2 个表：`DISPATCHPRICE`、`DISPATCHREGIONSUM`。
- 月份：2024-12、2025-01、2025-02、2025-03。
- 每个表每月同时存在 `.CSV` 与 `.feather`，共 16 个文件。
- CSV 是 AEMO MMS 原始格式；Feather 是 NEMOSIS 生成的本地中间缓存。
- 训练配置范围为 2025-01-01 至 2025-03-31；2024-12 文件属于下载边界/缓存，不进入最终合并训练区间。

### 4.2 `DISPATCHPRICE` 原始字段（66 个）

`SETTLEMENTDATE`, `RUNNO`, `REGIONID`, `DISPATCHINTERVAL`, `INTERVENTION`, `RRP`, `EEP`, `ROP`, `APCFLAG`, `MARKETSUSPENDEDFLAG`, `LASTCHANGED`, `RAISE6SECRRP`, `RAISE6SECROP`, `RAISE6SECAPCFLAG`, `RAISE60SECRRP`, `RAISE60SECROP`, `RAISE60SECAPCFLAG`, `RAISE5MINRRP`, `RAISE5MINROP`, `RAISE5MINAPCFLAG`, `RAISEREGRRP`, `RAISEREGROP`, `RAISEREGAPCFLAG`, `LOWER6SECRRP`, `LOWER6SECROP`, `LOWER6SECAPCFLAG`, `LOWER60SECRRP`, `LOWER60SECROP`, `LOWER60SECAPCFLAG`, `LOWER5MINRRP`, `LOWER5MINROP`, `LOWER5MINAPCFLAG`, `LOWERREGRRP`, `LOWERREGROP`, `LOWERREGAPCFLAG`, `PRICE_STATUS`, `PRE_AP_ENERGY_PRICE`, `PRE_AP_RAISE6_PRICE`, `PRE_AP_RAISE60_PRICE`, `PRE_AP_RAISE5MIN_PRICE`, `PRE_AP_RAISEREG_PRICE`, `PRE_AP_LOWER6_PRICE`, `PRE_AP_LOWER60_PRICE`, `PRE_AP_LOWER5MIN_PRICE`, `PRE_AP_LOWERREG_PRICE`, `CUMUL_PRE_AP_ENERGY_PRICE`, `CUMUL_PRE_AP_RAISE6_PRICE`, `CUMUL_PRE_AP_RAISE60_PRICE`, `CUMUL_PRE_AP_RAISE5MIN_PRICE`, `CUMUL_PRE_AP_RAISEREG_PRICE`, `CUMUL_PRE_AP_LOWER6_PRICE`, `CUMUL_PRE_AP_LOWER60_PRICE`, `CUMUL_PRE_AP_LOWER5MIN_PRICE`, `CUMUL_PRE_AP_LOWERREG_PRICE`, `OCD_STATUS`, `MII_STATUS`, `RAISE1SECRRP`, `RAISE1SECROP`, `RAISE1SECAPCFLAG`, `LOWER1SECRRP`, `LOWER1SECROP`, `LOWER1SECAPCFLAG`, `PRE_AP_RAISE1_PRICE`, `PRE_AP_LOWER1_PRICE`, `CUMUL_PRE_AP_RAISE1_PRICE`, `CUMUL_PRE_AP_LOWER1_PRICE`。

### 4.3 `DISPATCHREGIONSUM` 原始字段（125 个）

基础与能源字段：

`SETTLEMENTDATE`, `RUNNO`, `REGIONID`, `DISPATCHINTERVAL`, `INTERVENTION`, `TOTALDEMAND`, `AVAILABLEGENERATION`, `AVAILABLELOAD`, `DEMANDFORECAST`, `DISPATCHABLEGENERATION`, `DISPATCHABLELOAD`, `NETINTERCHANGE`, `EXCESSGENERATION`。

Lower 5min/60sec/6sec 字段：

`LOWER5MINDISPATCH`, `LOWER5MINIMPORT`, `LOWER5MINLOCALDISPATCH`, `LOWER5MINLOCALPRICE`, `LOWER5MINLOCALREQ`, `LOWER5MINPRICE`, `LOWER5MINREQ`, `LOWER5MINSUPPLYPRICE`, `LOWER60SECDISPATCH`, `LOWER60SECIMPORT`, `LOWER60SECLOCALDISPATCH`, `LOWER60SECLOCALPRICE`, `LOWER60SECLOCALREQ`, `LOWER60SECPRICE`, `LOWER60SECREQ`, `LOWER60SECSUPPLYPRICE`, `LOWER6SECDISPATCH`, `LOWER6SECIMPORT`, `LOWER6SECLOCALDISPATCH`, `LOWER6SECLOCALPRICE`, `LOWER6SECLOCALREQ`, `LOWER6SECPRICE`, `LOWER6SECREQ`, `LOWER6SECSUPPLYPRICE`。

Raise 5min/60sec/6sec 字段：

`RAISE5MINDISPATCH`, `RAISE5MINIMPORT`, `RAISE5MINLOCALDISPATCH`, `RAISE5MINLOCALPRICE`, `RAISE5MINLOCALREQ`, `RAISE5MINPRICE`, `RAISE5MINREQ`, `RAISE5MINSUPPLYPRICE`, `RAISE60SECDISPATCH`, `RAISE60SECIMPORT`, `RAISE60SECLOCALDISPATCH`, `RAISE60SECLOCALPRICE`, `RAISE60SECLOCALREQ`, `RAISE60SECPRICE`, `RAISE60SECREQ`, `RAISE60SECSUPPLYPRICE`, `RAISE6SECDISPATCH`, `RAISE6SECIMPORT`, `RAISE6SECLOCALDISPATCH`, `RAISE6SECLOCALPRICE`, `RAISE6SECLOCALREQ`, `RAISE6SECPRICE`, `RAISE6SECREQ`, `RAISE6SECSUPPLYPRICE`。

供给、Regulation 与违约字段：

`AGGEGATEDISPATCHERROR`, `AGGREGATEDISPATCHERROR`, `LASTCHANGED`, `INITIALSUPPLY`, `CLEAREDSUPPLY`, `LOWERREGIMPORT`, `LOWERREGLOCALDISPATCH`, `LOWERREGLOCALREQ`, `LOWERREGREQ`, `RAISEREGIMPORT`, `RAISEREGLOCALDISPATCH`, `RAISEREGLOCALREQ`, `RAISEREGREQ`, `RAISE5MINLOCALVIOLATION`, `RAISEREGLOCALVIOLATION`, `RAISE60SECLOCALVIOLATION`, `RAISE6SECLOCALVIOLATION`, `LOWER5MINLOCALVIOLATION`, `LOWERREGLOCALVIOLATION`, `LOWER60SECLOCALVIOLATION`, `LOWER6SECLOCALVIOLATION`, `RAISE5MINVIOLATION`, `RAISEREGVIOLATION`, `RAISE60SECVIOLATION`, `RAISE6SECVIOLATION`, `LOWER5MINVIOLATION`, `LOWERREGVIOLATION`, `LOWER60SECVIOLATION`, `LOWER6SECVIOLATION`。

可用性、间歇式能源、WDR 与双向机组字段：

`RAISE6SECACTUALAVAILABILITY`, `RAISE60SECACTUALAVAILABILITY`, `RAISE5MINACTUALAVAILABILITY`, `RAISEREGACTUALAVAILABILITY`, `LOWER6SECACTUALAVAILABILITY`, `LOWER60SECACTUALAVAILABILITY`, `LOWER5MINACTUALAVAILABILITY`, `LOWERREGACTUALAVAILABILITY`, `LORSURPLUS`, `LRCSURPLUS`, `TOTALINTERMITTENTGENERATION`, `DEMAND_AND_NONSCHEDGEN`, `UIGF`, `SEMISCHEDULE_CLEAREDMW`, `SEMISCHEDULE_COMPLIANCEMW`, `SS_SOLAR_UIGF`, `SS_WIND_UIGF`, `SS_SOLAR_CLEAREDMW`, `SS_WIND_CLEAREDMW`, `SS_SOLAR_COMPLIANCEMW`, `SS_WIND_COMPLIANCEMW`, `WDR_INITIALMW`, `WDR_AVAILABLE`, `WDR_DISPATCHED`, `SS_SOLAR_AVAILABILITY`, `SS_WIND_AVAILABILITY`, `RAISE1SECLOCALDISPATCH`, `LOWER1SECLOCALDISPATCH`, `RAISE1SECACTUALAVAILABILITY`, `LOWER1SECACTUALAVAILABILITY`, `BDU_ENERGY_STORAGE`, `BDU_MIN_AVAIL`, `BDU_MAX_AVAIL`, `BDU_CLEAREDMW_GEN`, `BDU_CLEAREDMW_LOAD`。

## 5. 离线 Parquet 数据与模型输入

### 5.1 `data/cache/dispatch_prices.parquet`

- 来源：DS-01 的 `DISPATCHPRICE`，由 NEMOSIS 筛选五个 NEM 区域后生成。
- 形式：Parquet。
- 规模：128,160 行 × 13 列。
- 时间：2025-01-01 00:05 至 2025-03-31 00:00。
- 字段：`SETTLEMENTDATE`, `REGIONID`, `INTERVENTION`, `RRP`, `RAISE6SECRRP`, `RAISE60SECRRP`, `RAISE5MINRRP`, `RAISEREGRRP`, `LOWER6SECRRP`, `LOWER60SECRRP`, `LOWER5MINRRP`, `LOWERREGRRP`, `PRICE_STATUS`。
- 使用：主模型合并时只取 `SETTLEMENTDATE`, `REGIONID`, `RRP`；VPP 商务测算额外使用 8 个 FCAS RRP 字段。

### 5.2 `data/cache/dispatch_region_summary.parquet`

- 来源：DS-01 的 `DISPATCHREGIONSUM`。
- 形式：Parquet。
- 规模：128,160 行 × 27 列。
- 字段：`SETTLEMENTDATE`, `REGIONID`, `DISPATCHINTERVAL`, `INTERVENTION`, `TOTALDEMAND`, `AVAILABLEGENERATION`, `AVAILABLELOAD`, `DEMANDFORECAST`, `DISPATCHABLEGENERATION`, `DISPATCHABLELOAD`, `NETINTERCHANGE`, `EXCESSGENERATION`, `LOWER5MINLOCALDISPATCH`, `LOWER60SECLOCALDISPATCH`, `LOWER6SECLOCALDISPATCH`, `RAISE5MINLOCALDISPATCH`, `RAISE60SECLOCALDISPATCH`, `RAISE6SECLOCALDISPATCH`, `INITIALSUPPLY`, `CLEAREDSUPPLY`, `LOWERREGLOCALDISPATCH`, `RAISEREGLOCALDISPATCH`, `TOTALINTERMITTENTGENERATION`, `DEMAND_AND_NONSCHEDGEN`, `UIGF`, `SEMISCHEDULE_CLEAREDMW`, `SEMISCHEDULE_COMPLIANCEMW`。

### 5.3 `data/processed/nem_merged.parquet`

- 来源：价格缓存与区域摘要缓存按 `SETTLEMENTDATE + REGIONID` 左连接。
- 形式：Parquet。
- 规模：128,160 行 × 10 列。
- 字段：`SETTLEMENTDATE`, `REGIONID`, `RRP`, `TOTALDEMAND`, `AVAILABLEGENERATION`, `CLEAREDSUPPLY`, `INITIALSUPPLY`, `DISPATCHABLEGENERATION`, `DISPATCHABLELOAD`, `NETINTERCHANGE`。

### 5.4 `data/processed/nem_featured.parquet`

- 来源：`nem_merged.parquet` 经价格变换、滞后、滚动、日历、节假日和跨区价差特征工程生成。
- 形式：Parquet。
- 规模：126,720 行 × 58 列。
- 完整字段：

`SETTLEMENTDATE`, `REGIONID`, `RRP`, `TOTALDEMAND`, `AVAILABLEGENERATION`, `CLEAREDSUPPLY`, `INITIALSUPPLY`, `DISPATCHABLEGENERATION`, `DISPATCHABLELOAD`, `NETINTERCHANGE`, `price_transformed`, `lag_price_1`, `lag_rrp_1`, `lag_price_2`, `lag_rrp_2`, `lag_price_3`, `lag_rrp_3`, `lag_price_6`, `lag_rrp_6`, `lag_price_12`, `lag_rrp_12`, `lag_price_24`, `lag_rrp_24`, `lag_price_48`, `lag_rrp_48`, `lag_price_96`, `lag_rrp_96`, `lag_price_288`, `lag_rrp_288`, `roll_mean_12`, `roll_std_12`, `roll_max_12`, `roll_min_12`, `roll_spike_count_12`, `roll_mean_48`, `roll_std_48`, `roll_max_48`, `roll_min_48`, `roll_spike_count_48`, `roll_mean_288`, `roll_std_288`, `roll_max_288`, `roll_min_288`, `roll_spike_count_288`, `tod_sin`, `tod_cos`, `dow_sin`, `dow_cos`, `month_sin`, `month_cos`, `is_weekend`, `is_holiday`, `is_spike`, `is_negative_spike`, `spread_NSW1_QLD1`, `spread_VIC1_NSW1`, `spread_VIC1_SA1`, `spread_VIC1_TAS1`。

### 5.5 模型实际输入的 43 个字段

`AVAILABLEGENERATION`, `CLEAREDSUPPLY`, `DISPATCHABLEGENERATION`, `DISPATCHABLELOAD`, `INITIALSUPPLY`, `NETINTERCHANGE`, `TOTALDEMAND`, `dow_cos`, `dow_sin`, `is_holiday`, `is_weekend`, `lag_price_1`, `lag_price_2`, `lag_price_3`, `lag_price_6`, `lag_price_12`, `lag_price_24`, `lag_price_48`, `lag_price_96`, `lag_price_288`, `month_cos`, `month_sin`, `roll_max_12`, `roll_max_48`, `roll_max_288`, `roll_mean_12`, `roll_mean_48`, `roll_mean_288`, `roll_min_12`, `roll_min_48`, `roll_min_288`, `roll_spike_count_12`, `roll_spike_count_48`, `roll_spike_count_288`, `roll_std_12`, `roll_std_48`, `roll_std_288`, `spread_NSW1_QLD1`, `spread_VIC1_NSW1`, `spread_VIC1_SA1`, `spread_VIC1_TAS1`, `tod_cos`, `tod_sin`。

目标/标签字段：`price_transformed`, `is_spike`；原始展示目标为 `RRP`。

## 6. Webapp 外部来数字段

### 6.1 DispatchIS

项目从一个 DispatchIS ZIP 中解析四类表：

- `DISPATCH_PRICE`：`SETTLEMENTDATE`, `REGIONID`, `INTERVENTION`, `RRP`, `RAISE6SECRRP`, `RAISE60SECRRP`, `RAISE5MINRRP`, `RAISEREGRRP`, `RAISE1SECRRP`, `LOWER6SECRRP`, `LOWER60SECRRP`, `LOWER5MINRRP`, `LOWERREGRRP`, `LOWER1SECRRP`。
- `DISPATCH_REGIONSUM`：`SETTLEMENTDATE`, `REGIONID`, `INTERVENTION`, `TOTALDEMAND`, `AVAILABLEGENERATION`, `NETINTERCHANGE`。
- `DISPATCH_INTERCONNECTORRES`：`SETTLEMENTDATE`, `INTERCONNECTORID`, `INTERVENTION`, `METEREDMWFLOW`, `MWFLOW`, `MWLOSSES`, `EXPORTLIMIT`, `IMPORTLIMIT`, `MNSP`。
- `DISPATCH_CONSTRAINT`：`SETTLEMENTDATE`, `CONSTRAINTID`, `INTERVENTION`, `RHS`, `MARGINALVALUE`, `VIOLATIONDEGREE`；代码只保存 `MARGINALVALUE != 0` 的 binding constraints。

### 6.2 Dispatch SCADA

来数字段：`SETTLEMENTDATE`, `DUID`, `SCADAVALUE`。

### 6.3 P5MIN 与 PREDISPATCHIS

- P5MIN：`RUN_DATETIME`, `INTERVAL_DATETIME`, `REGIONID`, `INTERVENTION`, `RRP`, `TOTALDEMAND`，以及 10 个 FCAS RRP 字段。
- PREDISPATCH Region Prices：`DATETIME`, `REGIONID`, `INTERVENTION`, `PREDISPATCH_RUN_DATETIME`/`LASTCHANGED`, `RRP`，以及 10 个 FCAS RRP 字段。
- PREDISPATCH Region Solution：`DATETIME`, `REGIONID`, `INTERVENTION`, `TOTALDEMAND`。
- 10 个 FCAS RRP：`RAISE1SECRRP`, `RAISE6SECRRP`, `RAISE60SECRRP`, `RAISE5MINRRP`, `RAISEREGRRP`, `LOWER1SECRRP`, `LOWER6SECRRP`, `LOWER60SECRRP`, `LOWER5MINRRP`, `LOWERREGRRP`。

### 6.4 竞价数据

`BIDDAYOFFER` 使用字段：

`SETTLEMENTDATE`/`EFFECTIVEDATE`, `DUID`, `BIDTYPE`, `DIRECTION`, `ENTRYTYPE`, `PRICEBAND1`–`PRICEBAND10`, `DAILYENERGYCONSTRAINT`, `T1`, `T2`, `T3`, `T4`, `MINIMUMLOAD`, `LASTCHANGED`/`OFFERDATE`。

`BIDPEROFFER` 使用字段：

`INTERVAL_DATETIME`, `SETTLEMENTDATE`/`EFFECTIVEDATE`, `TRADINGDATE`, `PERIODID`, `PERIODIDTO`, `DUID`, `BIDTYPE`, `DIRECTION`, `BANDAVAIL1`–`BANDAVAIL10`, `MAXAVAIL`, `FIXEDLOAD`, `ROCUP`/`RAMPUPRATE`, `ROCDOWN`/`RAMPDOWNRATE`, `LASTCHANGED`/`OFFERDATETIME`/`OFFERDATE`/`AUTHORISEDDATE`, `REBIDREASON`, `REBIDEXPLANATION`。

### 6.5 ST PASA

来数字段：`INTERVAL_DATETIME`, `REGIONID`, `DEMAND10`/`DEMAND_10`, `DEMAND50`/`DEMAND_50`, `DEMAND90`/`DEMAND_90`, `AVAILABLEGENERATION`/`AVAILABLE_GENERATION`/`AGGREGATEPASAAVAILABILITY`, `LRC`/`LOR1LEVEL`, `RESERVECONDITION`, `RUN_DATETIME`/`LASTCHANGED`。

### 6.6 Rooftop PV

来数字段：`INTERVAL_DATETIME`, `REGIONID`, `POWER`。

### 6.7 Participant Registration / MLF

- `DUDETAILSUMMARY`：`DUID`, `REGIONID`, `DISPATCHTYPE`, `STATIONID`, `TRANSMISSIONLOSSFACTOR`, `SCHEDULE_TYPE`, `START_DATE`, `END_DATE`。
- `DUDETAIL`：`DUID`, `EFFECTIVEDATE`, `REGISTEREDCAPACITY`, `MAXCAPACITY`。
- `DUALLOC`：`DUID`, `GENSETID`, `EFFECTIVEDATE`。
- `GENUNITS`：`GENSETID`, `CO2E_ENERGY_SOURCE`, `CO2E_EMISSIONS_FACTOR`, `REGISTEREDCAPACITY`, `LASTCHANGED`。
- `STATION`：`STATIONID`, `STATIONNAME`, `LASTCHANGED`。

### 6.8 WEMDE JSON

- 顶层：`transactionId`, `data`。
- `data`：`tradingDay`, `referenceTradingPrices`。
- `referenceTradingPrices[]`：`tradingInterval`, `referenceTradingPrice`, `isPublished`。
- 项目当前只落地 `tradingInterval` 和 `referenceTradingPrice`；`isPublished` 未保存，`mcap_price` 字段存在但采集器写入 `NULL`。

### 6.9 Open-Meteo JSON

实时天气接口使用：`temperature_2m`, `apparent_temperature`, `wind_speed_10m`, `wind_direction_10m`, `shortwave_radiation`, `precipitation`, `weather_code`。

预测模型天气缓存使用：`time`, `temperature_2m`, `shortwave_radiation`, `wind_speed_10m`。

代表坐标：Sydney/NSW1、Brisbane/QLD1、Melbourne/VIC1、Adelaide/SA1、Hobart/TAS1；时区固定为 `Australia/Brisbane`，用于对齐 NEM UTC+10 市场时钟。

### 6.10 ASX Energy HTML

解析区域/产品：NSW=`BN`、QLD=`BQ`、VIC=`BV`、SA=`BS`，产品为 Base Load Quarterly Futures。

字段：`expiry`, `open`, `high`, `low`, `last`, `settlement`, `change`, `open_interest`, `open_interest_change`, `volume`, `contract_hours`；外层元数据为 `exchange`, `market`, `product`, `currency`, `unit`, `price_type`, `trading_date`, `retrieved_at`, `source_url`, `region`, `region_name`, `commodity_code`。

### 6.11 Amber API

- `/sites` 使用：`id`, `status`。
- `/sites/{site}/prices/current` 使用：`channelType`, `spotPerKwh`, `endTime`/`nemTime`。
- 只读取 `channelType=general`；`spotPerKwh` 从 c/kWh 乘 10 转成 AUD/MWh。

### 6.12 新闻 RSS

来数/落地字段：`url`, `title`, `source`, `author`, `published_at`, `summary`, `image_url`, `categories`, `fetched_at`。正文不落库，只保存清洗后的短摘要和原文链接。

### 6.13 Market Notices

从纯文本标签提取：`Notice ID`, `Notice Type ID`, `Notice Type Description`, `Creation Date`, `External Reference`, `Reason`。

## 7. Webapp SQLite 数据字典

以下是当前代码定义的目标数据库结构。旧的本地 `market.sqlite3` 可能要在应用启动迁移后才会具有全部表和字段。

### 7.1 外部市场数据表

#### `nem_dispatch_price`

来源：DS-02/DS-03。  
字段：`settlementdate`, `regionid`, `rrp`, `raise6sec_rrp`, `raise60sec_rrp`, `raise5min_rrp`, `raisereg_rrp`, `raise1sec_rrp`, `lower6sec_rrp`, `lower60sec_rrp`, `lower5min_rrp`, `lowerreg_rrp`, `lower1sec_rrp`。

#### `nem_region_summary`

来源：DS-02/DS-03。  
字段：`settlementdate`, `regionid`, `totaldemand`, `availablegeneration`, `netinterchange`。

#### `nem_unit_dispatch`

来源：DS-04。  
字段：`settlementdate`, `duid`, `mw`。

#### `nem_dispatch_constraint`

来源：DS-02/DS-03。  
字段：`settlementdate`, `constraintid`, `rhs`, `marginalvalue`, `violationdegree`。

#### `nem_interconnector_flow`

来源：DS-02/DS-03。  
字段：`settlementdate`, `interconnectorid`, `metered_mw_flow`, `mw_flow`, `mw_losses`, `export_limit`, `import_limit`, `mnsp`。

#### `wem_price`

来源：DS-13。  
字段：`interval_start`, `reference_trading_price`, `mcap_price`。

#### `nem_predispatch_price`

来源：DS-05/DS-06。  
字段：`interval_datetime`, `regionid`, `source`, `run_datetime`, `rrp`, `total_demand`, `raise6sec_rrp`, `raise60sec_rrp`, `raise5min_rrp`, `raisereg_rrp`, `raise1sec_rrp`, `lower6sec_rrp`, `lower60sec_rrp`, `lower5min_rrp`, `lowerreg_rrp`, `lower1sec_rrp`。

#### `nem_st_pasa`

来源：DS-08。  
字段：`interval_datetime`, `regionid`, `demand10`, `demand50`, `demand90`, `available_generation`, `lrc`, `reservecondition`, `run_datetime`。

#### `nem_bidday_offer`

来源：DS-07。  
字段：`settlementdate`, `duid`, `bidtype`, `direction`, `entrytype`, `priceband1`–`priceband10`, `daily_energy_constraint`, `t1`, `t2`, `t3`, `t4`, `minimumload`, `submitted_at`。

#### `nem_bidper_offer`

来源：DS-07。  
字段：`interval_datetime`, `duid`, `bidtype`, `direction`, `bandavail1`–`bandavail10`, `maxavail`, `fixedload`, `rampuprate`, `rampdownrate`, `submitted_at`, `rebid_reason`, `rebid_explanation`, `version`。

#### `nem_rooftop_pv`

来源：DS-09。  
字段：`settlementdate`, `regionid`, `power_mw`。

#### `nem_market_notice`

来源：DS-11。  
字段：`notice_id`, `notice_type`, `type_description`, `creation_date`, `external_ref`, `reason`。

#### `nem_news`

来源：DS-17。  
字段：`url`, `title`, `source`, `author`, `published_at`, `summary`, `image_url`, `categories`, `fetched_at`。

#### `nem_facility_registry`

来源：DS-10。  
字段：`duid`, `station`, `region`, `fuel`, `capacity_mw`, `dispatch_type`, `schedule_type`, `tlf`, `co2e_source`, `emissions_factor`, `source_month`, `updated_at`。

#### `nem_mlf`

来源：DS-10 自动刷新 + DS-12 静态种子。  
字段：`duid`, `financial_year`, `station_name`, `region`, `fuel_type`, `capacity_mw`, `mlf`, `lat`, `lon`。

#### `weather_cache`

来源：DS-14。  
字段：`regionid`, `datetime`, `temp_c`, `ghi`, `wind_kmh`。

### 7.2 派生预测与采集状态表

#### `forecast_eval`

来源：AEMO、朴素模型、自研残差模型、Amber、LightGBM 的锁定日前预测。  
字段：`target_datetime`, `regionid`, `model`, `predicted_rrp`, `made_at`。

#### `scraper_state`

来源：采集器运行状态。  
字段：`source`, `last_file`, `last_run`, `last_error`。

### 7.3 纸面交易模拟表

#### `paper_bess_state`

字段：`duid`, `capacity_mwh`, `power_mw`, `rte_pct`, `soc_mwh`, `cumulative_pnl_aud`, `last_settled_interval`, `updated_at`, `mlf`。

#### `paper_bid`

字段：`bid_id`, `duid`, `target_settlementdate`, `market`, `direction`, `submitted_at`, `status`, `bands_json`, `notes`, `previous_bid_id`, `fcas_trapezium_json`。

#### `paper_fill`

字段：`fill_id`, `bid_id`, `duid`, `settlementdate`, `market`, `cleared_price`, `enabled_mw`, `energy_mwh`, `revenue_aud`, `created_at`。

### 7.4 VPP 模拟运营表

#### `vpp_portfolio`

字段：`portfolio_id`, `display_name`, `registered_duid`, `region`, `cumulative_pnl_aud`, `updated_at`, `baseline_method`, `classification`, `customer_share_pct`。

#### `vpp_resource`

字段：`resource_id`, `portfolio_id`, `kind`, `site_name`, `lat`, `lon`, `nameplate_kw`, `capacity_kwh`, `rte_pct`, `soc_kwh`, `availability_now`, `window_start_hr`, `window_end_hr`, `can_inject`, `can_curtail`, `can_raise_fcas`, `can_lower_fcas`, `can_reg_fcas`, `max_events_per_day`, `max_duration_min`, `recovery_min`, `mlf`, `dispatch_type`, `retail_plan`, `opted_in`, `created_at`, `updated_at`。

#### `vpp_bid`

字段：`bid_id`, `portfolio_id`, `target_settlementdate`, `market`, `direction`, `submitted_at`, `status`, `bands_json`, `allocation_json`, `notes`, `rebid_reason`, `previous_bid_id`, `max_avail_mw`, `daily_energy_constraint_mwh`, `ramp_up_mw_per_min`, `ramp_down_mw_per_min`, `t1_sec`, `t2_sec`, `t3_sec`, `t4_sec`, `enablement_min_mw`, `enablement_max_mw`, `low_breakpoint_mw`, `high_breakpoint_mw`, `trading_day_batch_id`。

#### `vpp_fill`

字段：`fill_id`, `bid_id`, `portfolio_id`, `settlementdate`, `market`, `direction`, `cleared_price`, `enabled_mw`, `energy_mwh`, `revenue_aud`, `mlf_applied`, `created_at`。

#### `vpp_fill_alloc`

字段：`fill_alloc_id`, `fill_id`, `portfolio_id`, `resource_id`, `settlementdate`, `market`, `direction`, `alloc_mw`, `alloc_mwh`, `revenue_aud`, `soc_delta_kwh`, `created_at`。

## 8. 静态参考与地图数据

### 8.1 来源可信度口径

| 等级 | 含义 | 本项目中的典型情况 |
|---|---|---|
| 已确认 | 能确认直接来源地址及来数形式 | 州界 GeoJSON 的直接下载地址 |
| 部分确认 | 能确认上游和查询条件，但不能用仓库内容完全复现当前文件 | OSM 输电线/变电站 GeoJSON |
| 人工整理 | 代码写明参考来源，但没有原始文件、导入脚本、版本或逐行证据 | 发电机、互联线、MLF 静态种子 |
| 模拟数据 | 由项目代码为了演示/测算直接设定，不来自外部系统 | VPP 资源、纸面 BESS 账户 |

### 8.2 地图文件逐项来源

| 文件 | 当前数据量 | 确认的直接来源 | 来数及加工形式 | 属性字段 | 结论 |
|---|---:|---|---|---|---|
| `webapp/frontend/public/aus-states.geojson` | 8 个 Feature | DS-20 的 `australian-states.min.geojson` | 远端精简 GeoJSON 直接下载并复制到前端静态目录 | `STATE_CODE`, `STATE_NAME`；Geometry 为 Polygon/MultiPolygon | **已确认**到直接下载地址；但 GitHub 上游没有清楚交代更早的政府原始数据和许可 |
| `webapp/frontend/public/nsw-transmission.geojson` | 4,666 条 LineString | DS-18，OpenStreetMap Overpass 法国镜像 | bbox 查询 → Overpass JSON → 一次性转换脚本 → 坐标四舍五入/精简 GeoJSON | `v`=kV，`op`=OSM `operator` | **部分确认**；上游、查询和转换规则已找到，但原始响应和 `/tmp` 转换脚本未保留 |
| `webapp/frontend/public/nsw-substations.geojson` | 383 个 Point | DS-18，OpenStreetMap Overpass 法国镜像 | node/way 查询 → way 取 center → 一次性转换脚本 → GeoJSON | `v`=kV，`name`=OSM `name` | **部分确认**；同上 |
| `webapp/frontend/public/nem-transmission.geojson` | 9,404 条 LineString | DS-18，OpenStreetMap Overpass 多个镜像 | 按州/分块查询 → 合并 NSW 文件和各州部分结果 → 按“电压 + 首坐标 + 坐标数”近似去重 → GeoJSON | `v`, `op` | **部分确认**；上游已确认，但构建过程中有超时、分块和补抓，最终一次性合并脚本未入库，不能严格重现当前 9,404 条 |
| `webapp/frontend/public/nem-substations.geojson` | 1 个 Point | DS-18，OpenStreetMap Overpass | NEM 变电站查询的残留/部分结果 | `v`, `name` | **无效的不完整图层**；不能代表全 NEM 变电站，应隐藏或重建 |

文件进入 Git 的时间线：州界和 NSW 两个电网文件于 2026-05-25 的初始提交加入；两个 NEM 合并文件于 2026-06-24 加入。Git 只保存最终压缩 GeoJSON，没有保存原始 Overpass JSON。

#### NSW 查询条件

- 边界框：`south=-37.5, west=140.5, north=-28.0, east=154.0`。
- 输电线：`way[power=line]`，电压筛选 `132000|220000|275000|330000|500000` 伏，使用 `out geom` 获取折线坐标。
- 变电站：`node[power=substation]` 与 `way[power=substation]`，同样筛选上述电压；way 使用 Overpass 返回的中心点。
- 最终保留形式：线为 `LineString`，站为 `Point`；坐标顺序是 `[longitude, latitude]`。

NSW 文件的电压分布：

| 电压 | 输电线条数 | 变电站点数 |
|---:|---:|---:|
| 132 kV | 3,822 | 288 |
| 220 kV | 188 | 22 |
| 275 kV | 0 | 0 |
| 330 kV | 605 | 64 |
| 500 kV | 51 | 9 |

#### NEM 合并查询条件

- NSW：`(-37.5, 141.0, -28.2, 153.7)`。
- QLD：`(-29.0, 138.0, -10.7, 153.5)`。
- VIC：`(-39.2, 141.0, -34.0, 149.9)`。
- SA：`(-38.1, 129.0, -26.0, 141.0)`。
- TAS：`(-43.7, 143.8, -40.5, 148.3)`。
- 输电设施筛选：OSM `power=line`/`power=cable`，电压 132/220/275/330/500 kV。

`nem-transmission.geojson` 的电压分布：132 kV 6,487 条、220 kV 1,536 条、275 kV 74 条、330 kV 976 条、500 kV 331 条。

#### 当前 `fetch_transmission.py` 的关系

根目录 `fetch_transmission.py` 是后来补写、且当前未被 Git 跟踪的下载脚本。它使用 `https://overpass-api.de/api/interpreter`，计划分别生成 QLD/VIC/SA/TAS 的输电线和变电站文件，筛选 132/220/275/330/500 kV。它**不是**当前 `nsw-*` 或 `nem-*` 合并文件的原始构建脚本，当前目录中也不存在它计划输出的 8 个分州文件，因此不能把它视为现有 GeoJSON 的完整可复现证据。

#### 地图数据许可与质量限制

- OSM 派生文件受 [OpenStreetMap 版权与 ODbL 许可](https://www.openstreetmap.org/copyright)约束，展示时应明确标注“© OpenStreetMap contributors”。当前地图组件没有看到清楚的 OSM attribution，这是合规缺口。
- Overpass 是对 OSM 社区数据的查询，不是 AEMO 或输电运营商的权威网络模型。线路缺失、重复、operator 为空、变电站主要被画成 way/relation 而非 node 都会影响结果。
- DS-20 的州界文件虽然能追到 GitHub 直接下载地址，但上游仓库没有清楚许可说明；正式发布前应换成许可明确的澳大利亚政府边界数据，或补齐原始许可证据。

### 8.3 发电机静态表

文件：`webapp/backend/app/static/generators.py`。  
形式：代码内人工维护的 Python `list[dict]`，不是从 AEMO 自动下载的文件。  
记录数：168 个主要 NEM DUID；代码所说“覆盖约 85% 装机容量”没有附计算底表，因此只能视为作者说明。区域数量为 NSW1 47、QLD1 45、VIC1 39、SA1 25、TAS1 12。  
字段：`duid`, `station`, `region`, `fuel`, `capacity_mw`, `lat`, `lon`。  
燃料枚举：`coal_black`, `coal_brown`, `gas`, `hydro`, `wind`, `solar`, `battery`, `bioenergy`。  
燃料数量：wind 49、coal_black 34、solar 28、gas 18、hydro 15、battery 14、coal_brown 10；当前没有实际 `bioenergy` 记录。

来源结论：文件注释称参考 AEMO Generation Information，并与 NEM Registration 交叉核对；仓库没有保存原始报表、URL、发布日期、导入脚本或逐行来源。DUID 可在 [AEMO Generation and Load 数据](https://aemo.com.au/energy-systems/electricity/national-electricity-market-nem/data-nem/market-management-system-mms-data/generation-and-load)及项目的 AEMO 注册/SCADA 数据中进一步校验，但这不能自动证明当前 `station`、`capacity_mw`、`fuel`、`lat/lon` 均正确。经纬度在代码中明确标为 approximate。故该文件属于**人工二次整理数据**，不应作为权威设施主数据。

当前自动设施注册采集器读取 DS-10 的 `DUDETAILSUMMARY`、`DUDETAIL`、`DUALLOC`、`GENUNITS`、`STATION`，可以更新 DUID、站点、容量、燃料、调度类别、TLF 和排放因子；它不会更新 `generators.py` 的地图坐标。

### 8.4 互联线静态表

文件：`webapp/backend/app/static/interconnectors.py`。  
形式：代码内人工维护的 Python `dict`。  
记录数：6 条：`NSW1-QLD1`（QNI）、`VIC1-NSW1`（VNI）、`V-SA`（Heywood）、`V-S-MNSP1`（Murraylink）、`T-V-MNSP1`（Basslink）、`N-Q-MNSP1`（Terranora）。  
字段：字典键为 `interconnectorid`；属性为 `name`, `long_name`, `region_from`, `region_to`, `from`, `to`, `nominal_limit_mw`, `mnsp`。`from`/`to` 是 `[lon,lat]`。

来源结论：仓库没有保存这 6 条记录的外部原始文件或导入脚本；代码明确说明两端坐标为 approximate、`nominal_limit_mw` 为 indicative，因此属于**人工参考拓扑**。运行时真正使用的每时段潮流和限制来自 DS-02/DS-03 的 AEMO `DISPATCH_INTERCONNECTORRES`：`METEREDMWFLOW`, `MWFLOW`, `MWLOSSES`, `EXPORTLIMIT`, `IMPORTLIMIT`, `MNSP`。静态表中的 nominal limit 不能替代调度时段限制。

同文件的 `REGION_CENTROIDS` 也是人工设定的五区标签/聚类中心，字段为 `regionid -> [lon,lat]`，不是 AEMO 结算节点或气象观测站。

### 8.5 MLF 静态种子

文件：`webapp/backend/app/db.py` 中 `_mlf_seed`。  
形式：代码内 73 条 Python tuple，经 `INSERT OR IGNORE` 写入 `nem_mlf`。  
字段：`duid`, `financial_year`, `station_name`, `region`, `fuel_type`, `capacity_mw`, `mlf`, `lat`, `lon`。  
声明来源：代码注释指向 DS-12 的 AEMO FY2025-26 Loss Factor Report；其中坐标明确为 approximate grid connection point locations。

来源结论：AEMO 官方 FY2025-26 PDF 已找到，但项目没有保存 PDF 到仓库、页码/行号映射、表格提取程序或逐条校验结果。`mlf` 可视为“声称由官方报告人工转录”，而 `station_name`、燃料、容量和坐标是项目附加字段；当前还不能将 73 行整体标为已验证官方数据。运行时 DS-10 会从 MMSDM `DUDETAILSUMMARY.TRANSMISSIONLOSSFACTOR` 刷新 DUID/TLF，静态经纬度仍不会随之更新。

### 8.6 地图 UI 与天气代表坐标

| 数据 | 文件 | 形式/字段 | 来源结论 |
|---|---|---|---|
| 13 个城市锚点 | `webapp/frontend/src/components/NEMMap.tsx` 的 `NEM_CITIES` | `name`, `coord=[lon,lat]`, `major` | 人工录入的城市近似坐标，仅用于地图空间参照 |
| 州/区域标签与缩放 | 同文件的 `STATE_FOR_REGION`, `LABEL_ANCHOR`, `STATE_VIEW`，以及投影 center/scale | 区域名称映射、`[lon,lat]`、zoom、投影参数 | UI 布局常量，不是市场或地理权威数据 |
| 预测模型天气代表点 | `webapp/backend/app/forecast/weather.py` 的 `_COORDS` | `regionid -> (lat,lon)` | 人工选取 Sydney、Brisbane、Melbourne、Adelaide、Hobart 作为区域负荷中心代表点；不是全州平均，也不是气象站点 |
| 天气页面代表点 | `webapp/backend/app/routes/weather.py` 的 `_LOCATIONS` | `lat`, `lon`, `city`, `tz` | 人工城市中心；NEM 五区加 Perth/WEM，用于调用 Open-Meteo |
| 燃料颜色/图标 | `generators.py` 的 `FUEL_COLORS`、`NEMMap.tsx` 的 `FUEL_SHAPE` | 色值、SVG path 规则 | 纯 UI 设计常量，不属于外部数据源 |

### 8.7 模拟静态种子

这些数据虽然静态存在于数据库初始化代码中，但来源不是外部市场或地图服务：

- `paper_bess_state`：预置 WTAHB1 纸面账户参数，包括 1,680 MWh、850 MW、88% RTE、初始 50% SoC、MLF 0.9923。它是模拟交易账户配置，不是实时设备遥测；代码对“真实规格/MLF”的说明没有保存逐字段原始引用。
- `vpp_portfolio`：预置 `NSW_CI_VPP` 演示组合，字段见 7.4；`registered_duid=VPPNSW1` 是演示标识，不应视为 AEMO 已注册 DUID。
- `vpp_resource`：预置 3 个 BESS 和 5 个 EV 充电资源。站点名称、Sydney 周边经纬度、容量、SoC、可用率、响应窗口、FCAS 能力、MLF、调度类型和零售计划均由项目代码设定，是**合成演示数据**。

### 8.8 手工监管参数

文件：`webapp/backend/app/config.py` 与 forecast 模块。  
字段/常量：`CPT_THRESHOLD_AUD`, `CPT_INTERVALS`, `APC_PRICE_AUD`, `NEM_FLOOR`, `NEM_CAP`。  
当前值对应代码注明的 FY2026-27 口径；来源写在注释中但没有绑定具体 AEMC/AEMO 文档 URL。它们属于人工录入的监管参考参数，存在年度变更风险，生产使用前需要按适用财年重新核对。

## 9. VPP 商务测算数据

### 9.1 上游来源

- 实际市场数据：`data/cache/dispatch_prices.parquet` 中 NSW1 的 2025 Q1 `RRP` 和 8 个 FCAS RRP。
- 人工假设：电池容量/功率、零售峰谷电价、往返效率、退化成本、季节折减、预测折减、FCAS 可用率、运营商分成、每日循环次数、工商业工作时间。
- 竞品资料：各公司官网、ARENA、pv magazine、Energy-Storage.News 等公开资料，未保存逐行 URL。

### 9.2 `vpp_business_case/results.csv`

- 形式：CSV，2 行 × 18 列。
- 字段：`segment`, `batt_kwh`, `batt_kw`, `A_retail_spread_ckwh`, `A_vpp_year`, `A_operator_year`, `B_arb_year`, `B_fcas_year`, `B_vpp_year`, `B_operator_year`, `B_arb_year_2cyc`, `B_vpp_year_2cyc`, `B_operator_year_2cyc`, `uplift_vpp_year`, `uplift_x`, `uplift_operator_year`, `degr_B_arb_year`, `fcas_avail_frac`。

### 9.3 `vpp_business_case/fleet.csv`

- 形式：CSV，3 行 × 5 列。
- 字段：`segment`, `sites`, `operator_A_year`, `operator_B_year`, `operator_uplift_year`。

### 9.4 `vpp_business_case/hourly_profile.csv`

- 形式：CSV，24 行 × 2 列。
- 来源：NSW1 2025 Q1 按小时聚合的典型日价格曲线。
- 字段：`SETTLEMENTDATE`（实际存小时 0–23）, `rrp`。

### 9.5 `vpp_business_case/meta.json`

字段：`region`, `source`, `period`, `days`, `intervals`, `rrp_mean`, `rrp_neg_pct`, `assumptions`。  
`assumptions` 子字段：`RT_EFF`, `DEGR_COST`, `ARB_SEASONAL`, `FORESIGHT`, `FCAS_SEASONAL`, `FCAS_AVAIL`, `OPERATOR_SHARE`, `MAX_CYCLES`, `work_hours`。

### 9.6 `VPP收益测算表.xlsx`

形式：Excel，5 个页签。

- `测算总览`：字段/指标包括阶段、聚合规模、运营商收益、说明，以及运营商分成、BESS 分成、效率、季节/预见性折减、BESS 单位收益、现货套利价差。
- `单位经济性测算`：`指标`, `户用（每户）`, `工商业（每站）`；指标包含储能容量、功率、方案 A 收益、方案 B 套利/FCAS/合计、提升倍数、单位收益、运营商分成。
- `聚合规模与收益`：`阶段`, `资产类型`, `聚合规模(MW)`, `单位收益`, `单位口径`, `毛收益(万AUD/年)`, `分成`, `运营商收益(万AUD/年)`, `对标数据来源`。
- `增长轨迹`：`时点`, `民居 VPP`, `工商业 VPP`, `BESS 运营`, `合计`。
- `典型日演示`：汇总字段为场景、套利、FCAS、日 VPP 收益、运营商分成、年化；小时表字段为小时、现货价、户用动作/电量/收益、工商业动作/电量/收益。

### 9.7 `VPP竞品对比.xlsx`

形式：Excel，1 个页签 `竞品对比`。  
字段：`类别`, `名称`, `平台/产品`, `面向场景`, `规模 / 实绩`, `主要服务`, `收费模式`。

### 9.8 PPT/PDF/JPG 文件

`vpp_business_case/` 中的 PPTX、PDF、JPG、PNG 主要是以上结构化数据和研究结果的演示输出，包括 VPP 立项测算、竞品对比、商务政策、资产放量策略、运营推广和投入回报分析。它们不是新的机器可读上游数据源，不再单独定义字段。

注意：`model.py`、`scen_control.py` 和多个构建脚本仍硬编码旧路径 `/sessions/funny-upbeat-darwin/mnt/claude-PriceForecastNEM`，在当前桌面路径不能直接重跑。

## 10. 其他 CSV 与未引用数据

### 10.1 `outputs/sa1_active_bess_latest.csv`

- 形式：CSV，15 行 × 6 列。
- 字段：`duid`, `station`, `capacity_mw`, `lat`, `lon`, `coordinate_source`。
- 来源：`coordinate_source` 中混合记录 `project`、`Network Map/KCI`、substation/site approx 等；仓库没有生成脚本或完整原始引用。
- 使用状态：当前核心模型和 Webapp 代码未引用。

### 10.2 `china_regions.csv`

- 形式：CSV，5 行 × 2 列。
- 字段：`区域`, `省份`。
- 内容：中国一区至中国五区及省份映射。
- 来源：仓库未记录。
- 使用状态：与 NEM/WEM 项目无关，当前代码未引用。

### 10.3 临时/锁文件

`vpp_business_case/` 中存在 `lu*.tmp`、`.~lock.*` 等 LibreOffice 临时/锁文件。这些不是业务数据源，建议清理或加入忽略规则。

## 11. 当前本地数据实际状态

### 11.1 离线数据

- `dispatch_prices.parquet`：128,160 行，五区各 25,632 行。
- `dispatch_region_summary.parquet`：128,160 行。
- 两个缓存均无重复主键，五区均无 5 分钟断点。
- `nem_featured.parquet` 的 43 个模型输入字段无空值。
- 当前没有 `p5min_forecasts.parquet`。

### 11.2 当前 `market.sqlite3`

文件大小约 22 MB，最后修改时间为 2026-05-29。本次审计在不启动应用、不执行迁移的前提下读取到：

- 0 行：NEM 价格、区域摘要、SCADA、约束、互联线、P5MIN/PREDISPATCH、WEM、竞价、PASA。
- 73 行：`nem_mlf` 静态种子。
- 1 行：`paper_bess_state`。
- 1 行：`vpp_portfolio`。
- 8 行：`vpp_resource`。
- 新代码定义的 `forecast_eval`, `weather_cache`, `nem_rooftop_pv`, `nem_market_notice`, `nem_news`, `nem_facility_registry` 尚未出现在该旧数据库快照中。

## 12. 数据血缘与质量问题

1. **P5MIN 名义接入、实际缺失**：离线下载代码会调用 NEMSEER，但本机训练日志记录模块缺失，因此当前 GNN/GBRT 数据没有 P5MIN。
2. **模型文件与当前配置漂移**：现有 `best_model.pt` 仅保存第 1 轮，使用旧的 288 步序列和 4 个预测期限；当前 `config.yaml` 已改成 96 步和 3 个期限。
3. **本地实时数据库未填充**：不能仅依据代码声明认为本地已经拥有实时 NEM/WEM/天气/竞价数据。
4. **静态数据缺少逐行来源**：generator、MLF、互联线和部分站点坐标没有报告版本、下载日期和逐条 URL；州界虽已找到直接下载地址，但其上游原始政府来源和许可仍不清楚。
5. **地图合并产物不完整**：`nem-substations.geojson` 只有 1 个点，且最终生成过程未保存；这会让地图数据看起来比实际覆盖范围完整。
6. **WEM 字段未完整保留**：`isPublished` 没有落库，`mcap_price` 没有采集来源。
7. **竞品研究不可逐行复核**：工作簿只有来源类别，没有每个公司/数字对应的网页 URL 和访问日期。
8. **数据文件不受 Git 管理**：可重现性依赖外部接口和本机缓存；建议记录数据快照日期、文件哈希、代码版本和下载日志。
9. **商务测算路径失效**：多个脚本硬编码旧 session 路径，当前工作区无法直接重算。
10. **可选 bid archive 路径不完整**：代码引用 `nem_bidper_offer_archive`，但当前数据库初始化没有创建该表；默认 `BIDS_HOT_DAYS=0` 时不会触发，若启用 rolling archive 需先补齐 schema。

## 13. 建议的数据治理补充项

- 建立 `source_manifest`：记录数据集 ID、来源 URL、下载时间、文件名、SHA256、代码 commit、记录数、时间范围。
- 为静态 generators/MLF/GeoJSON 增加 `source_url`, `source_date`, `verified_at`, `confidence`。
- 重建全 NEM 变电站图层时同时查询 OSM node/way/relation，保存 Overpass 查询、原始 JSON、转换脚本和文件哈希，并在地图中加入 OSM attribution。
- 将 P5MIN、PREDISPATCH、天气和模型训练数据分别保存版本化快照，避免数据库“只保留最新 vintage”后无法复现历史预测。
- 为实时表增加 freshness/coverage 检查，并区分“表存在”“有数据”“数据新鲜”。
- 把商务测算的人工假设集中到一个配置表，逐项标注来源、单位和是否可编辑。
- 删除或隔离 `china_regions.csv`、LibreOffice 临时文件等与核心项目无关的数据。
