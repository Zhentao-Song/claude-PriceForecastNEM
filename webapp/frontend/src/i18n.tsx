/**
 * Tiny in-house i18n. Two languages (English, 简体中文), flat dotted keys, no
 * dependencies. The dictionary lives next to the provider so adding a string
 * is one edit. Persists choice to localStorage and listens for changes.
 *
 * Usage:
 *   const { t, lang, setLang } = useT()
 *   <h1>{t('intro.titleNem')}</h1>
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'

export type Lang = 'en' | 'zh'

const STORAGE_KEY = 'nemwem.lang'

// ---- Dictionary ----------------------------------------------------------
// Keep keys ASCII + dotted; values are plain strings (no JSX, no formatting).
// Anywhere we need interpolation we just compose the result client-side.

const DICT: Record<string, { en: string; zh: string }> = {
  // Header
  'header.title':        { en: 'NEM / WEM Live',                           zh: 'NEM / WEM 实时' },
  'header.subtitle':     { en: 'BESS & VPP operations console',            zh: 'BESS 与 VPP 调度控制台' },
  'header.updated':      { en: 'Updated',                                  zh: '更新于' },
  'header.live':         { en: 'Live',                                     zh: '实时' },
  'header.idle':         { en: 'Idle',                                     zh: '待机' },
  'header.lang.en':      { en: 'EN',                                       zh: 'EN' },
  'header.lang.zh':      { en: '中文',                                      zh: '中文' },

  // View toggle + page intro
  'nav.allNem':          { en: 'NEM',                                      zh: 'NEM' },
  'nav.nswDeepDive':     { en: 'NSW-BESS',                                  zh: 'NSW-BESS' },
  'nav.vpp':             { en: 'NSW-VPP',                                   zh: 'NSW-VPP' },
  'nav.bessCalc':        { en: 'BESS-Calc',                                 zh: 'BESS-Calc' },
  'intro.titleBessCalc': { en: 'BESS project finance, in one screen.',      zh: 'BESS 项目融资测算,一屏看穿。' },
  'intro.subtitleBessCalc': {
    en: 'Drop in your asset spec + capital structure. Revenue assumptions are pre-calibrated from the last 90 days of real NEM RRP/FCAS data for your chosen region.',
    zh: '填资产规模 + 融资结构,收益假设直接取最近 90 天该州真实 RRP/FCAS 行情校准。',
  },

  // VPP console (full section)
  'vpp.kicker':          { en: 'C&I Virtual Power Plant',                  zh: '工商业虚拟电厂' },
  'vpp.cumPnl':          { en: 'Cumulative P&L',                           zh: '累计 P&L' },
  'vpp.nameplate':       { en: 'Nameplate',                                zh: '装机容量' },
  'vpp.availableNow':    { en: 'Available now',                            zh: '当前可用' },
  'vpp.bessFleet':       { en: 'BESS fleet',                               zh: '储能群' },
  'vpp.bessSoc':         { en: 'Fleet SoC',                                zh: '储能 SoC' },
  'vpp.evFleet':         { en: 'EV charger fleet',                         zh: '充电桩群' },
  'vpp.sites':           { en: 'sites',                                    zh: '站点' },
  'vpp.optedIn':         { en: 'opted in',                                 zh: '已参与' },
  'vpp.ofNameplate':     { en: 'of nameplate',                             zh: '装机' },
  'vpp.roster.title':    { en: 'Resource roster',                          zh: '资源清单' },
  'vpp.roster.hint':     {
    en: 'Per-site capability + opt-in. Uncheck to exclude a site from all bid envelopes.',
    zh: '每个站点的能力 + 参与开关。取消勾选可将该站点从所有报价中剔除。',
  },
  'vpp.col.site':        { en: 'Site',                                     zh: '站点' },
  'vpp.col.kind':        { en: 'Type',                                     zh: '类型' },
  'vpp.col.kw':          { en: 'Nameplate',                                zh: '装机' },
  'vpp.col.window':      { en: 'Window',                                   zh: '可用窗口' },
  'vpp.col.caps':        { en: 'Capability',                               zh: '能力' },
  'vpp.col.optIn':       { en: 'In',                                       zh: '参与' },
  'vpp.col.soc':         { en: 'SoC',                                      zh: 'SoC' },
  'vpp.col.pnl24h':      { en: 'P&L 24h',                                  zh: 'P&L 24h' },
  'vpp.col.events':      { en: 'Events',                                   zh: '调度次数' },
  // Algorithmic suggestions
  'vpp.sug.kicker':      { en: 'Algorithmic suggestions',                  zh: '算法推荐报价' },
  'vpp.sug.title':       { en: 'Forecast-driven bid ladders',              zh: '基于预测的报价梯子' },
  'vpp.sug.hint':        {
    en: 'P5MIN forecast → 10-band ladder → one-click submit. Respects envelope, SoC, customer-contract limits.',
    zh: 'P5MIN 预测 → 10 档梯子 → 一键提交。已考虑容量上限、SoC、客户合同约束。',
  },
  'vpp.sug.items':       { en: 'suggestions',                              zh: '条建议' },
  'vpp.sug.col.when':    { en: 'When',                                     zh: '时段' },
  'vpp.sug.col.market':  { en: 'Market',                                   zh: '市场' },
  'vpp.sug.col.bands':   { en: 'Bands ($/MWh@MW)',                         zh: '档位 ($/MWh@MW)' },
  'vpp.sug.col.envelope': { en: 'Envelope',                                zh: '容量上限' },
  'vpp.sug.col.estRev':  { en: 'Est. revenue',                             zh: '预计收入' },
  'vpp.sug.col.rationale': { en: 'Rationale',                              zh: '依据' },
  'vpp.sug.accept':      { en: 'Submit',                                   zh: '提交' },
  // Customer demand-charge
  'vpp.dc.kicker':       { en: 'Customer demand-charge',                   zh: '客户需量电费' },
  'vpp.dc.title':        { en: 'Per-site peak shaving · last 30 days',     zh: '各站点削峰 · 近 30 天' },
  'vpp.dc.params':       {
    en: 'Peak window {0} · ${1}/kVA/month tariff · VPP {2}% share',
    zh: '尖峰时段 {0} · ${1}/kVA/月费率 · VPP 抽成 {2}%',
  },
  'vpp.dc.vppShare':     { en: 'VPP monthly cut',                          zh: 'VPP 月分成' },
  'vpp.dc.customerSaves': { en: 'Customer saves ${0}/月 total',             zh: '客户共节省 ${0}/月' },
  'vpp.dc.col.site':     { en: 'Site',                                     zh: '站点' },
  'vpp.dc.col.peakDown': { en: 'Peak ↓',                                   zh: '尖峰降' },
  'vpp.dc.col.events':   { en: '30d events',                               zh: '30天事件' },
  'vpp.dc.col.monthly':  { en: 'Customer saves',                           zh: '客户节省' },
  'vpp.dc.col.vppCut':   { en: 'VPP cut',                                  zh: 'VPP 抽成' },
  'vpp.dc.col.cusKeep':  { en: 'Customer keeps',                           zh: '客户保留' },
  'vpp.dc.idle':         { en: 'No peak-window dispatch yet · potential {0} kW = ${1}/月',
                            zh: '尚无尖峰时段调度 · 潜在 {0} kW = ${1}/月' },
  'vpp.dc.note':         {
    en: 'Computed from REAL settled BESS GEN events during the peak window. The peak-window max MW per site = customer\'s monthly demand-charge reduction at the connection point.',
    zh: '基于真实结算的 BESS 放电事件计算。各站点尖峰时段最大 MW = 客户连接点的月度需量电费削减。',
  },
  'vpp.bid.title':       { en: 'Compose bid',                              zh: '报价编辑' },
  'vpp.bid.hint':        {
    en: '10-band ladder (NER 3.8.6A.1). Server validates: monotonic, gate closure (T−5min), envelope, capability.',
    zh: '10 档价格阶梯（NER 3.8.6A.1）。服务端校验：单调递增、闸门关闭、容量上限、资源能力。',
  },
  'vpp.bid.target':      { en: 'Target interval',                          zh: '目标时段' },
  'vpp.bid.market':      { en: 'Market',                                   zh: '市场' },
  'vpp.bid.direction':   { en: 'Direction',                                zh: '方向' },
  'vpp.bid.envelope':    { en: 'Envelope · MW available',                  zh: '可投容量上限' },
  'vpp.bid.eligibleSites': { en: 'eligible sites',                         zh: '可用站点' },
  'vpp.bid.bandPrice':   { en: 'Price $/MWh',                              zh: '价格 $/MWh' },
  'vpp.bid.bandMw':      { en: 'MW',                                       zh: 'MW' },
  'vpp.bid.addBand':     { en: 'Add band',                                 zh: '加一档' },
  'vpp.bid.reason':      { en: 'Reason code',                              zh: '原因码' },
  'vpp.bid.note':        { en: 'Note (optional)',                          zh: '说明（可选）' },
  'vpp.bid.notePh':      { en: 'e.g. heatwave, demand uplift…',            zh: '如：高温、负荷上调…' },
  'vpp.bid.submit':      { en: 'Submit bid',                               zh: '提交报价' },
  'vpp.bid.submitting':  { en: 'Submitting…',                              zh: '提交中…' },
  'vpp.bid.modeSingle':  { en: 'Single interval',                          zh: '单个时段' },
  'vpp.bid.modeDay':     { en: 'Trading day',                              zh: '整交易日' },
  'vpp.bid.targetDay':   { en: 'Trading date',                             zh: '交易日' },
  'vpp.bid.hintDay':     {
    en: 'BIDDAYOFFER-style: one price ladder + ops params applied to every open 5-min interval in the trading day.',
    zh: 'BIDDAYOFFER 模式：一组价格 + 运行参数批量应用到当日所有未关闸的 5min 时段。',
  },
  'vpp.bid.advanced':    { en: 'Advanced parameters',                      zh: '高级参数' },
  'vpp.bid.maxAvail':    { en: 'MaxAvail (MW)',                            zh: 'MaxAvail · 总功率硬上限' },
  'vpp.bid.dailyEnergy': { en: 'DailyEnergyConstraint (MWh)',              zh: 'DailyEnergyConstraint · 当日 MWh 上限' },
  'vpp.bid.rampUp':      { en: 'Ramp up rate (MW/min)',                    zh: '上爬坡率 (MW/min)' },
  'vpp.bid.rampDown':    { en: 'Ramp down rate (MW/min)',                  zh: '下爬坡率 (MW/min)' },
  'vpp.bid.trapTitle':   { en: 'FCAS co-optimisation trapezium',           zh: 'FCAS 协同优化梯形' },
  'vpp.bid.ladder':      { en: 'Price ladder',                             zh: '价格阶梯' },
  'vpp.bid.autoLadder':  { en: 'auto · fits envelope',                     zh: '智能默认 · 适配 envelope' },
  'vpp.bid.autoTip':     {
    en: 'Defaults are derived from market + direction + envelope. Edit any band to take manual control.',
    zh: '默认值按市场 + 方向 + envelope 自动推导。任何一格被编辑后会锁定为手动模式。',
  },
  'vpp.bid.edited':      { en: 'manual',                                   zh: '已手动调整' },
  'vpp.bid.reset':       { en: 'Reset',                                    zh: '重置默认' },
  'vpp.ledger.title':    { en: 'Bid ledger',                               zh: '报价台账' },
  'vpp.ledger.hint':     { en: 'All bids from this portfolio · most recent first', zh: '本聚合账户所有报价 · 最新在上' },
  'vpp.ledger.bids':     { en: 'bids',                                     zh: '条' },
  'vpp.ledger.empty':    { en: 'No bids yet — submit one above.',          zh: '暂无报价 — 在上方提交。' },
  'vpp.ledger.target':   { en: 'Target',                                   zh: '目标' },
  'vpp.ledger.market':   { en: 'Market',                                   zh: '市场' },
  'vpp.ledger.dir':      { en: 'Dir',                                      zh: '方向' },
  'vpp.ledger.maxMw':    { en: 'Max MW',                                   zh: '上限 MW' },
  'vpp.ledger.alloc':    { en: 'Allocation',                               zh: '资源分配' },
  'vpp.ledger.reason':   { en: 'Reason',                                   zh: '原因' },
  'vpp.ledger.status':   { en: 'Status',                                   zh: '状态' },
  'vpp.ledger.cancel':   { en: 'cancel',                                   zh: '撤回' },
  'vpp.customerShare':   { en: 'customer share {0}%',                      zh: '客户分成 {0}%' },
  // Revenue breakdown section
  'vpp.rev.title':       { en: 'Revenue mix',                              zh: '收益构成' },
  'vpp.rev.subtitle':    { en: 'Last {0} h · wholesale + customer-side',   zh: '近 {0} 小时 · 现货 + 客户侧' },
  'vpp.rev.totalAll':    { en: 'All-in total',                             zh: '合计' },
  'vpp.rev.energy':      { en: 'Energy',                                   zh: '能量套利' },
  'vpp.rev.fcasRaise':   { en: 'FCAS Raise',                               zh: 'FCAS 调频上' },
  'vpp.rev.fcasLower':   { en: 'FCAS Lower',                               zh: 'FCAS 调频下' },
  'vpp.rev.demand':      { en: 'Demand-charge (est.)',                     zh: '需量电费分成（估算）' },
  'vpp.rev.noFills':     { en: 'No wholesale settlements yet — submit a bid above.', zh: '尚无现货结算 — 在上方提交报价。' },
  'vpp.rev.note':        {
    en: '{0} wholesale fills settled. Customer demand-charge is a 24h-prorated estimate (customer total savings ≈ ${1}, VPP share per portfolio config). Classification: {2}.',
    zh: '已结算 {0} 条现货成交。需量电费按 24 小时比例估算（客户总节省约 ${1}，VPP 按组合配置抽成）。注册类: {2}。',
  },

  // ===== Bid Lifecycle Timeline ==========================================
  'lc.kicker':           { en: 'AEMO BID LIFECYCLE',                       zh: 'AEMO 报价生命周期' },
  'lc.title':            { en: 'From price lock to final settlement',      zh: '从锁价到终结算的完整链路' },
  'lc.hint':             {
    en: 'Eight stages spanning ~30 calendar days. Click any node to see the rule, actor, and how it maps to our codebase.',
    zh: '八个阶段,跨度约 30 个日历日。点击任一节点查看该步骤的规则、责任方,以及在我们代码里的映射位置。',
  },
  'lc.anchor':           { en: 'Today\'s example anchor',                  zh: '今日示例锚点' },
  'lc.expand':           { en: 'Stage detail',                             zh: '阶段详情' },
  'lc.collapse':         { en: 'Hide detail',                              zh: '收起详情' },
  'lc.impl':             { en: 'Implementation reference',                 zh: '代码实现位置' },
  'lc.example':          {
    en: 'In today\'s example this stage would occur at: {0}',
    zh: '在今日示例中,此阶段对应时间: {0}',
  },
  'lc.legend.participant': { en: 'Participant action',                     zh: '参与者动作' },
  'lc.legend.aemo':        { en: 'AEMO action',                            zh: 'AEMO 动作' },
  'lc.legend.clickHint':   { en: 'Click any node for detail',              zh: '点击任意节点查看详情' },

  // Stage 1: BIDDAYOFFER lock
  'lc.stage.bidday.title':    { en: 'BIDDAYOFFER lock',                    zh: 'BIDDAYOFFER 锁价' },
  'lc.stage.bidday.subtitle': { en: '10-band price ladder locked for trading day', zh: '当日 10 档价格阶梯锁定' },
  'lc.stage.bidday.detail': {
    en: 'Participants submit their 10-band price ladder for each (DUID, market, direction) by 12:30 of D-1 (the day before the trading day). After this deadline, PRICES are locked for the entire trading day — only band MW availability can be rebid via BIDPEROFFER. The 10 bands must be strictly monotonically ascending and lie within [MPF, MPC] = [-$1000, $17,500/MWh] (2024-25). For BESS, this is also when DailyEnergyConstraint (MWh cap for the day) is registered.',
    zh: '参与者在交易日前一天 12:30 之前为每个(DUID,市场,方向)组合提交 10 档价格阶梯。这个时点之后,价格全天锁定 — 只能通过 BIDPEROFFER 重报每个 interval 的可用 MW。10 档价格必须严格单调递增,且在 [MPF, MPC] = [-$1000, $17500/MWh](2024-25 年)范围内。BESS 还在此时报当日 MWh 总上限(DailyEnergyConstraint)。',
  },

  // Stage 2: BIDPEROFFER rebid window
  'lc.stage.bidper.title':    { en: 'BIDPEROFFER rebid window',            zh: 'BIDPEROFFER 滚动 rebid' },
  'lc.stage.bidper.subtitle': { en: 'Per-interval MW + MaxAvail can be rebid',  zh: '每个 interval 的 MW + MaxAvail 可滚动重报' },
  'lc.stage.bidper.detail': {
    en: 'From 12:30 D-1 right up to T-5min for each dispatch interval, participants can rebid the MW availability (bandavail1..10), MaxAvail, ramp rates, and FCAS trapezium parameters for that interval. Each rebid MUST carry a reason code (PRICE/FORECAST/DEMAND/OUTAGE/RAMP/ENERGY_LIMIT/TEMPERATURE/STRATEGY/OTHER) plus a meaningful written explanation. AER has fined participants whose explanations were vague or formulaic — they read these.',
    zh: '从 D-1 12:30 一直到每个 dispatch interval 的 T-5min,参与者可以滚动重报该 interval 的 MW 可用量、MaxAvail、爬坡率、FCAS 梯形参数。每次 rebid 必须附原因码(PRICE/FORECAST/DEMAND/OUTAGE/RAMP/ENERGY_LIMIT/TEMPERATURE/STRATEGY/OTHER)+ 有实质内容的书面说明。AER 罚过措辞模糊或套话的参与者 —— 他们真在看。',
  },

  // Stage 3: Gate closure
  'lc.stage.gate.title':    { en: 'Gate closure (T-5min)',                 zh: '闸门关闭 (T-5min)' },
  'lc.stage.gate.subtitle': { en: 'Bids freeze for the upcoming interval', zh: '即将到来的 interval 报价冻结' },
  'lc.stage.gate.detail': {
    en: 'Exactly 5 minutes before the dispatch interval starts, AEMO closes the gate. After this point, no rebids are accepted for that interval — what\'s on file is what NEMDE will optimise against. AEMO\'s system rejects bid submissions post-gate with a hard error. We honour this client-side AND server-side, with a 30s safety buffer.',
    zh: 'dispatch interval 开始前正好 5 分钟,AEMO 关闸。之后该 interval 不再接受 rebid —— 已提交的就是 NEMDE 优化的输入。AEMO 系统对过闸提交直接硬拒。我们前端 + 后端双重校验,并预留 30s 安全缓冲。',
  },

  // Stage 4: NEMDE
  'lc.stage.nemde.title':    { en: 'NEMDE + dispatch instruction',         zh: 'NEMDE 优化 + 调度指令' },
  'lc.stage.nemde.subtitle': { en: 'AEMO clears the market + pushes targets', zh: 'AEMO 清算市场 + 下发指令' },
  'lc.stage.nemde.detail': {
    en: 'Inside the 5-min gate window, AEMO\'s National Electricity Market Dispatch Engine (NEMDE) runs the co-optimisation: energy + 10 FCAS markets, every network constraint, every bid, every loss factor — and outputs the dispatch target MW per DUID. About 1 minute before T-0, AEMO pushes each target via the EMMS B2B channel directly to the DUID\'s SCADA. The participant\'s control system has the next 5 minutes to follow that target. NOT MODELLED in our system — real platforms have AEMO MarketNet certificates + SCADA integration.',
    zh: '在闸门关闭后到 dispatch 开始前这 5 分钟,AEMO 的 NEMDE 跑联合优化:能量 + 10 个 FCAS 市场、所有电网约束、所有报价、所有损耗因子 —— 输出每个 DUID 的 dispatch target MW。约 T-1min 时,AEMO 通过 EMMS B2B 把目标值直接推送到每个 DUID 的 SCADA。参与者控制系统接下来 5 分钟要跟踪这个目标。我们没建模 —— 真实平台需要 AEMO MarketNet 证书 + SCADA 集成。',
  },

  // Stage 5: Dispatch
  'lc.stage.dispatch.title':    { en: 'Dispatch interval',                 zh: 'Dispatch 执行' },
  'lc.stage.dispatch.subtitle': { en: 'Asset follows the target via SCADA',zh: '资产按 SCADA 目标出力' },
  'lc.stage.dispatch.detail': {
    en: 'The 5-minute interval where the unit physically delivers what NEMDE asked for. For ENERGY, the dispatch target MW is constant for the full 5min (subject to ramp rates). For RAISE/LOWER REG FCAS, AGC sends 4-second SCADA signals continuously throughout the interval. NEMDE caps total dispatch at BIDPEROFFER.MaxAvail regardless of how many bands cleared — our settlement worker (`_cleared_mw`) honours this.',
    zh: '5 分钟的真实出力窗口。对于 ENERGY,dispatch target MW 在整个 5min 内恒定(受爬坡率约束)。对于 RAISE/LOWER REG FCAS,AGC 在整个 interval 内持续每 4 秒发送 SCADA 信号。NEMDE 把总 dispatch 卡在 BIDPEROFFER.MaxAvail 上限,不管多少档清出 —— 我们的结算逻辑(`_cleared_mw`)遵守这条。',
  },

  // Stage 6: RRP publish
  'lc.stage.rrp.title':    { en: 'DispatchIS + RRP published',             zh: 'DispatchIS + RRP 发布' },
  'lc.stage.rrp.subtitle': { en: 'AEMO publishes cleared prices',          zh: 'AEMO 公布清算价格' },
  'lc.stage.rrp.detail': {
    en: 'At T+5min (the moment the interval closes), AEMO publishes the DispatchIS report to nemweb.com.au: cleared Regional Reference Prices (RRP) for each region, FCAS clearing prices for each of the 10 FCAS markets, dispatched MW per DUID (DispatchSCADA), interconnector flows, and binding constraints. Our scraper polls this directory every 60 seconds and ingests new files, so the dashboard typically reflects new dispatch within 60-150s of T+5min.',
    zh: 'T+5min 时(interval 关闭瞬间),AEMO 把 DispatchIS 报告发布到 nemweb.com.au:各州清算 RRP、10 个 FCAS 市场的清算价、每个 DUID 的实际出力(DispatchSCADA)、联络线流量、binding 约束。我们的 scraper 每 60s 轮询这个目录抓新文件,所以仪表盘通常在 T+5min 之后 60-150s 内反映新一笔 dispatch。',
  },

  // Stage 7: Preliminary settlement
  'lc.stage.prelim.title':    { en: 'Preliminary settlement',              zh: '初步结算' },
  'lc.stage.prelim.subtitle': { en: 'AEMO\'s first-pass statement (T+1bd)',zh: 'AEMO 首次结算单 (T+1 工作日)' },
  'lc.stage.prelim.detail': {
    en: 'AEMO publishes the SETCFB_PDATA preliminary settlement statement around 1 business day after the trading day. This is your first opportunity to reconcile your shadow P&L against AEMO\'s official numbers. Differences come from MLF rounding, meter data corrections, constraint shadow prices. ⚠ NOT MODELLED: we compute P&L from RRP × MWh × MLF directly, so there\'s no reconciliation step. A real platform would diff our numbers against SETCFB_PDATA here.',
    zh: 'AEMO 在交易日后约 1 个工作日发布 SETCFB_PDATA 初步结算单。这是你第一次有机会用 AEMO 官方数字对账。差异通常来自 MLF 取整、电表数据修正、约束影子价。⚠ 没建模:我们直接用 RRP × MWh × MLF 算,没有对账步骤。真实平台会在这里 diff 我们的数字和 SETCFB_PDATA。',
  },

  // Stage 8: Final settlement
  'lc.stage.final.title':    { en: 'Final settlement (T+15bd)',            zh: '终结算 (T+15 工作日)' },
  'lc.stage.final.subtitle': { en: 'Money moves; ~$ flows to participant', zh: '资金清算到账;参与者收钱' },
  'lc.stage.final.detail': {
    en: 'AEMO publishes the SETCFB_CPDATA final settlement statement on the 15th business day. This is the definitive number — AEMO debits/credits participant accounts. Revisions are still possible up to T+30 business days but rarely material. ⚠ NOT MODELLED: a real participant would (a) reconcile final vs preliminary vs internal, (b) book the cash, (c) trigger customer revenue share payouts per their contracts. Our platform stops at the wholesale RRP × MWh shadow calc.',
    zh: 'AEMO 在第 15 个工作日发布 SETCFB_CPDATA 终结算单。这是最终数字 —— AEMO 借记/贷记参与者账户。T+30 工作日前还可能 revision 但通常无关紧要。⚠ 没建模:真实参与者会(a)对账 final vs preliminary vs 内部,(b)入账现金,(c)按合同触发客户收益分成。我们的平台到 wholesale RRP × MWh 影子计算就停了。',
  },

  // ===== Compliance footer toggle (in VPPConsole) ========================
  'vpp.complianceLink':     { en: 'Compliance scorecard',                  zh: '合规自查表' },
  'vpp.complianceLinkHint': {
    en: 'internal audit · click to expand',
    zh: '内部审计 · 点击展开',
  },

  // ===== Compliance Scorecard ============================================
  'cs.kicker':           { en: 'COMPLIANCE SCORECARD',                     zh: '合规自查表' },
  'cs.title':            { en: 'Prudent-participant snapshot',             zh: '审慎参与者评估' },
  'cs.hint':             {
    en: 'Rule coverage + AER-style conduct review + customer-contract check + data freshness over the last {0} days.',
    zh: '近 {0} 天:规则覆盖率 + AER 视角的参与行为审查 + 客户合同合规 + 数据新鲜度。',
  },
  'cs.overallScore':     { en: 'Overall score',                            zh: '综合评分' },
  'cs.window':           { en: 'Window',                                   zh: '窗口' },
  'cs.expand':           { en: 'Show details',                             zh: '展开详情' },
  'cs.collapse':         { en: 'Hide details',                             zh: '收起详情' },
  'cs.deductions':       { en: 'Score deductions',                         zh: '扣分明细' },
  'cs.reasonDist':       { en: 'Rebid reason distribution',                zh: 'Rebid 原因分布' },
  'cs.sum.bids':         { en: 'Bids',                                     zh: '总报价' },
  'cs.sum.settled':      { en: 'Settled',                                  zh: '已结算' },
  'cs.sum.pending':      { en: 'Pending',                                  zh: '待结算' },
  'cs.sum.rebids':       { en: 'Rebids',                                   zh: 'Rebid 次数' },
  'cs.sum.ruleCov':      { en: 'Rule coverage',                            zh: '规则覆盖' },
  'cs.sum.rules':        { en: 'rules',                                    zh: '条' },
  'cs.contracts.empty':  { en: 'No opted-in resources to check.',          zh: '暂无 opt-in 资源可检查。' },
  'cs.disclaimer':       {
    en: 'Score is a weighted blend of conduct (45%) + customer contracts (30%) + data freshness (25%). Rule-enforcement section is informational only — it lists which NER rules our validators cover vs which we explicitly skip. Honest about gaps: AEMO settlement reconciliation, causer-pays, and B2B dispatch-instruction SCADA are NOT modelled.',
    zh: '综合分 = 参与行为 45% + 客户合同 30% + 数据新鲜度 25% 的加权。规则覆盖部分仅作信息展示,列出我们 enforce 的 NER 规则和明确未做的部分。诚实声明:AEMO 终结算对账、causer-pays、B2B 调度指令 SCADA 都没建模。',
  },
  'intro.titleNem':      { en: 'Australian electricity, in real time.',    zh: '澳洲电力，实时一览。' },
  'intro.titleNsw':      { en: 'New South Wales · operations view.',       zh: '新南威尔士州 · 运营视图。' },
  'intro.subtitleNem':   {
    en: 'Live 5-minute spot prices and FCAS for every NEM region and the WEM — built for BESS arbitrage and VPP dispatch decisions.',
    zh: '覆盖 NEM 所有州 + WEM 的 5 分钟现货电价与 FCAS 实时数据，为 BESS 套利与 VPP 调度而生。',
  },
  'intro.subtitleNsw':   {
    en: 'Generation mix, supply–demand balance, and BESS charge/discharge state for the NSW1 region.',
    zh: 'NSW1 区域的发电构成、供需平衡，以及 BESS 的充放电状态。',
  },

  // Region tiles
  'tile.regionalPrice':  { en: 'Regional Reference Price',                 zh: '区域参考电价' },
  'tile.wemPrice':       { en: 'WEM · RTP',                                zh: 'WEM · 参考交易价' },
  'tile.forecastNext5':  { en: 'next 5min ·',                              zh: '下一 5 分钟 ·' },
  'tile.forecastNext':   { en: 'next interval ·',                          zh: '下一时段 ·' },
  'tile.next':           { en: 'next',                                     zh: '下一时段' },

  // Section headings on the All-NEM dashboard
  'sec.nemMap':          { en: 'NEM grid · interconnector flows',          zh: 'NEM 电网 · 联络线潮流' },
  'sec.nemMapHint':      {
    en: 'Line thickness ∝ utilisation · arrow shows current direction · dashed = HVDC (MNSP)',
    zh: '线宽与利用率成正比 · 箭头显示当前潮流方向 · 虚线为 HVDC（MNSP）',
  },
  'sec.priceTitle':      { en: '$/MWh · 5-minute dispatch',                zh: '$/MWh · 5 分钟调度' },
  'sec.timeline':        { en: 'Market timeline · this interval',          zh: '市场时间轴 · 本区间' },
  'sec.timelineHint': {
    en: 'Where this dispatch interval is in its lifecycle: BIDDAYOFFER → PREDISPATCH → P5MIN → gate closure → DISPATCH → settlement.',
    zh: '本调度区间所处的生命周期阶段：BIDDAYOFFER → PREDISPATCH → P5MIN → 闸门关闭 → DISPATCH → 结算。',
  },
  'timeline.kicker':     { en: 'Lifecycle for',                             zh: '生命周期 ·' },
  'timeline.title':      { en: 'Interval ending {0}',                       zh: '截止于 {0} 的区间' },
  'timeline.subtitle':   { en: 'Trading day {0} · {1} dispatch',           zh: '交易日 {0} · {1} 调度' },
  'timeline.now':        { en: 'now',                                       zh: '当前' },
  'timeline.closed':     { en: 'gate closed',                               zh: '已关闸' },
  'timeline.error':      { en: 'Timeline unavailable —',                    zh: '时间轴暂不可用 ——' },
  'timeline.yourDuid':   { en: 'Your DUID',                                 zh: '你的 DUID' },
  'timeline.dayAheadSubmitted': { en: 'Day-ahead submitted {0}',            zh: '前日提交于 {0}' },
  'timeline.dayAheadMissing':   { en: 'No day-ahead bid found',             zh: '未发现前日报价' },
  'timeline.versionsForInterval': { en: '{0} version(s) · latest {1}',     zh: '{0} 个版本 · 最新 {1}' },
  'timeline.duidsDayAhead':     { en: '{0} DUIDs',                          zh: '{0} 个机组' },
  'timeline.runsSoFar':         { en: '{0} runs so far',                    zh: '已运行 {0} 次' },
  'timeline.rebidsCount':       { en: '{0} rebids',                         zh: '{0} 次重报' },
  'sec.fcasMatrix':      { en: 'FCAS · 10-market matrix',                  zh: 'FCAS · 10 市场矩阵' },
  'sec.fcasMatrixHint':  {
    en: 'Latest dispatch interval · $/MW per hour · NEM regions',
    zh: '最新调度间隔 · $/MW · 小时 · NEM 各区域',
  },
  'sec.suffix.rrp':      { en: 'Regional Reference Price',                 zh: '区域参考电价' },
  'sec.suffix.wemRtp':   { en: 'WEM Reference Trading Price',              zh: 'WEM 参考交易电价' },

  // Footer
  'footer':              {
    en: 'Data: AEMO NEMWeb (DispatchIS) + AEMO WA WEMDE (Reference Trading Price). Stored locally · refresh 30s.',
    zh: '数据来源：AEMO NEMWeb (DispatchIS) + AEMO WA WEMDE (参考交易电价)。本地存储 · 30 秒刷新。',
  },

  // FCAS matrix legend
  'fcas.loading':        { en: 'Loading FCAS…',                            zh: '加载 FCAS…' },
  'fcas.region':         { en: 'Region',                                   zh: '区域' },
  'fcas.dispatchInterval': { en: 'Dispatch interval',                      zh: '调度间隔' },
  'fcas.legend':         {
    en: 'R = Raise contingency (1s · 6s · 60s · 5min) · RReg = Raise Regulation · L = Lower equivalents.',
    zh: 'R = 上调应急 (1s · 6s · 60s · 5min) · RReg = 上调调频 · L = 下调对应市场。',
  },
  'fcas.legend2':        {
    en: 'Mainland NSW / QLD / VIC / SA share an FCAS price when no regional constraint binds (NEM co-optimisation); TAS often differs due to Basslink.',
    zh: '当无区域约束生效时，大陆 NSW / QLD / VIC / SA 共享同一 FCAS 价格（NEM 联合优化）；TAS 因 Basslink 限制常单独定价。',
  },

  // NSW deep dive · price card
  'nsw.spotPrice':       { en: 'Spot price · $/MWh',                       zh: '现货电价 · $/MWh' },
  'nsw.vsLastHour':      { en: 'vs 1h ago',                                zh: '相对 1 小时前' },
  // Hero price card additions
  'price.nextForecast':  { en: 'Next interval · AEMO',                     zh: '下一时段 · AEMO 预测' },
  'price.fcasNow':       { en: 'FCAS · this interval',                     zh: 'FCAS · 本时段' },
  'price.demand':        { en: 'Total demand',                             zh: '总负荷' },
  'price.reserve':       { en: 'Reserve margin',                           zh: '备用容量' },

  // NSW deep dive · supply-demand card
  'nsw.supplyDemand':    { en: 'Supply & demand',                          zh: '供需平衡' },
  'nsw.demand':          { en: 'Demand',                                   zh: '负荷' },
  'nsw.localGen':        { en: 'Local generation',                         zh: '本地发电' },
  'nsw.netImport':       { en: 'Net import',                               zh: '净进口' },
  'nsw.netExport':       { en: 'Net export',                               zh: '净出口' },
  'nsw.balance':         { en: 'Balance',                                  zh: '余量' },

  // NSW deep dive · fuel mix card
  'nsw.fuelMix':         { en: 'Fuel mix',                                 zh: '电源构成' },
  'nsw.totalGen':        { en: 'Total',                                    zh: '总计' },
  'fuel.coal_black':     { en: 'Black coal',                               zh: '黑煤' },
  'fuel.coal_brown':     { en: 'Brown coal',                               zh: '褐煤' },
  'fuel.gas':            { en: 'Gas',                                      zh: '天然气' },
  'fuel.hydro':          { en: 'Hydro',                                    zh: '水电' },
  'fuel.bioenergy':      { en: 'Bioenergy',                                zh: '生物质' },
  'fuel.wind':           { en: 'Wind',                                     zh: '风电' },
  'fuel.solar':          { en: 'Solar',                                    zh: '光伏' },
  'fuel.battery':        { en: 'Battery',                                  zh: '电池' },

  // BESS card
  'bess.headline':       { en: 'Headline BESS',                            zh: '重点 BESS' },
  'bess.charging':       { en: 'Charging',                                 zh: '充电中' },
  'bess.discharging':    { en: 'Discharging',                              zh: '放电中' },
  'bess.idle':           { en: 'Idle',                                     zh: '空闲' },
  'bess.unknown':        { en: 'No data',                                  zh: '无数据' },
  'bess.capacity':       { en: 'Nameplate',                                zh: '额定' },
  'bess.online':         { en: 'unit online',                              zh: '台运行' },
  'bess.unitsOnline':    { en: 'units online',                             zh: '台运行' },

  // Position card (paper trading)
  'pos.title':           { en: 'Position',                                 zh: '持仓' },
  'pos.reset':           { en: 'Reset',                                    zh: '重置' },
  'pos.soc':             { en: 'State of charge',                          zh: '当前电量 (SoC)' },
  'pos.todayEnergy':     { en: 'Today · energy',                           zh: '今日 · 能量' },
  'pos.todayFcas':       { en: 'Today · FCAS',                             zh: '今日 · FCAS' },
  'pos.cumulative':      { en: 'Cumulative',                               zh: '累计' },
  'pos.submitBid':       { en: 'Submit bid',                               zh: '提交出价' },
  'pos.powerEnvelope':   { en: 'Power envelope · today',                   zh: '功率包线 · 今日' },
  'pos.charge':          { en: 'charge',                                   zh: '充电' },
  'pos.discharge':       { en: 'discharge',                                zh: '放电' },
  'pos.lastSettled':     { en: 'Last settled',                             zh: '上次结算' },
  'pos.loading':         { en: 'Loading…',                                 zh: '加载中…' },
  'pos.resetConfirm':    {
    en: 'Reset RYAN1 paper account? This wipes all bids and resets SoC to 50%.',
    zh: '确定重置 RYAN1 模拟账户？将清空全部出价，并把 SoC 还原为 50%。',
  },

  // Bid form
  'bid.title':           { en: 'Submit bid',                               zh: '提交出价' },
  'bid.subtitle':        { en: '10-band offer · price-taker · settled at AEMO RRP', zh: '10 价格带 · 价格接受者 · 按 AEMO RRP 结算' },
  'bid.target':          { en: 'Target interval (NEM time)',               zh: '目标时段（NEM 时间）' },
  'bid.next':            { en: 'next',                                     zh: '下一时段' },
  'bid.market':          { en: 'Market',                                   zh: '市场' },
  'bid.bands':           { en: 'Price bands',                              zh: '价格带' },
  'bid.col.no':          { en: '#',                                        zh: '#' },
  'bid.col.price':       { en: 'Price ($/MWh)',                            zh: '价格 ($/MWh)' },
  'bid.col.mw':          { en: 'MW available',                             zh: '可用 MW' },
  'bid.totalMw':         { en: 'Σ',                                        zh: '合计' },
  'bid.resetBands':      { en: 'Reset bands',                              zh: '重置价格带' },
  'bid.cancel':          { en: 'Cancel',                                   zh: '取消' },
  'bid.submit':          { en: 'Submit bid',                               zh: '提交出价' },
  'bid.submitting':      { en: 'Submitting…',                              zh: '提交中…' },
  'bid.group.energy':    { en: 'Energy',                                   zh: '能量市场' },
  'bid.group.raise':     { en: 'FCAS Raise (capacity)',                    zh: 'FCAS 上调（容量）' },
  'bid.group.lower':     { en: 'FCAS Lower (capacity)',                    zh: 'FCAS 下调（容量）' },
  'bid.opt.discharge':   { en: 'Discharge (sell)',                         zh: '放电（卖出）' },
  'bid.opt.charge':      { en: 'Charge (buy)',                             zh: '充电（买入）' },
  'bid.opt.raiseReg':    { en: 'RaiseReg',                                 zh: '上调调频' },
  'bid.opt.raise5min':   { en: 'Raise 5min',                               zh: '上调 5 分钟' },
  'bid.opt.raise60sec':  { en: 'Raise 60s',                                zh: '上调 60 秒' },
  'bid.opt.raise6sec':   { en: 'Raise 6s',                                 zh: '上调 6 秒' },
  'bid.opt.raise1sec':   { en: 'Raise 1s',                                 zh: '上调 1 秒' },
  'bid.opt.lowerReg':    { en: 'LowerReg',                                 zh: '下调调频' },
  'bid.opt.lower5min':   { en: 'Lower 5min',                               zh: '下调 5 分钟' },
  'bid.opt.lower60sec':  { en: 'Lower 60s',                                zh: '下调 60 秒' },
  'bid.opt.lower6sec':   { en: 'Lower 6s',                                 zh: '下调 6 秒' },
  'bid.opt.lower1sec':   { en: 'Lower 1s',                                 zh: '下调 1 秒' },
  'bid.hint.gen':        { en: 'Bands clear when price ≤ RRP. SoC depletes proportionally.', zh: '价格 ≤ RRP 的价格带成交。按比例消耗 SoC。' },
  'bid.hint.load':       { en: 'Bands clear when price ≥ RRP. Pays at RRP, charges into SoC at √RTE.', zh: '价格 ≥ RRP 的价格带成交。按 RRP 付费，按 √RTE 进入 SoC。' },
  'bid.hint.fcas':       { en: 'Capacity bid: bands clear when price ≤ FCAS RRP. Reservation does not deplete SoC.', zh: '容量出价：价格 ≤ FCAS RRP 时成交。预留不消耗 SoC。' },
  'bid.err.pickInterval': { en: 'pick a target interval',                  zh: '请选择目标时段' },
  'bid.err.atLeastOne':  { en: 'at least one band must have MW > 0',       zh: '至少一档价格带的 MW 须大于 0' },
  'bid.err.exceedsPower': { en: 'total {0} MW exceeds {1} MW power',       zh: '合计 {0} MW 超过 {1} MW 功率上限' },

  // Bid ledger
  'ledger.title':        { en: 'Bid ledger',                               zh: '出价明细' },
  'ledger.empty':        { en: 'No bids yet — submit one to start trading.', zh: '尚无出价 — 提交一条以开始交易。' },
  'ledger.summary':      { en: '{0} bids · {1} fills',                     zh: '{0} 条出价 · {1} 次成交' },
  'ledger.col.target':   { en: 'Target',                                   zh: '目标时段' },
  'ledger.col.market':   { en: 'Market',                                   zh: '市场' },
  'ledger.col.reason':   { en: 'Reason',                                   zh: '原因' },
  'ledger.col.bidMw':    { en: 'Bid MW',                                   zh: '出价 MW' },
  'ledger.chain.badge':  { en: 'v{0}/{1}',                                  zh: 'v{0}/{1}' },
  'ledger.chain.title':  { en: 'Rebid chain (oldest → newest):',            zh: '重报链(旧 → 新):' },
  'ledger.col.cleared':  { en: 'Cleared $',                                zh: '出清价' },
  'ledger.col.filled':   { en: 'Filled MW',                                zh: '成交 MW' },
  'ledger.col.pnl':      { en: 'P&L',                                      zh: '盈亏' },
  'ledger.col.status':   { en: 'Status',                                   zh: '状态' },
  'ledger.energyDischarge': { en: 'Energy discharge',                      zh: '能量 放电' },
  'ledger.energyCharge':  { en: 'Energy charge',                           zh: '能量 充电' },
  'ledger.cancel':       { en: 'cancel',                                   zh: '取消' },
  'ledger.cancelConfirm': { en: 'Cancel bid #{0}?',                        zh: '确认取消第 #{0} 条出价？' },
  'ledger.status.PENDING':   { en: 'PENDING',                              zh: '待结算' },
  'ledger.status.SETTLED':   { en: 'SETTLED',                              zh: '已结算' },
  'ledger.status.CANCELLED': { en: 'CANCELLED',                            zh: '已取消' },
  'ledger.status.EXPIRED':   { en: 'EXPIRED',                              zh: '已过期' },

  // Suggested bids (auto-generated from forecast)
  'sug.title':           { en: 'Suggested bid sheet',                       zh: '建议出价单' },
  'sug.badge':           { en: 'DEMO',                                      zh: '演示' },
  'sug.subtitle':        {
    en: 'Auto-generated from AEMO P5MIN + PREDISPATCH forecast · NSW1 · sells peaks (above p75), buys troughs (below p25).',
    zh: '基于 AEMO P5MIN + PREDISPATCH 预测自动生成 · NSW1 · 高价时段（高于 P75）放电、低价时段（低于 P25）充电。',
  },
  // Diagnostic strip — always visible so the heuristic is transparent.
  'sug.diag.pts':        { en: 'forecast pts: {0}',                         zh: '预测点：{0}' },
  'sug.diag.thresh':     { en: 'p25 / p75:',                                zh: 'P25 / P75：' },
  'sug.diag.bidPrices':  { en: 'bid:',                                      zh: '出价：' },
  'sug.diag.raw':        { en: 'raw: {0} peak · {1} trough',                zh: '候选：{0} 高峰 · {1} 低谷' },
  'sug.diag.skipped':    { en: 'skipped (already pending): {0}',            zh: '已挂出价跳过：{0}' },
  'sug.diag.lowSoc':     { en: 'SoC ≤ 5% — discharge disabled',             zh: 'SoC ≤ 5% — 暂停放电' },
  'sug.diag.highSoc':    { en: 'SoC ≥ 95% — charge disabled',               zh: 'SoC ≥ 95% — 暂停充电' },
  // Empty-state variants
  'sug.empty':           {
    en: 'No actionable arbitrage in the current forecast window — prices look flat.',
    zh: '当前预测窗口暂无显著套利机会 — 价格曲线较平。',
  },
  'sug.empty.noForecast': {
    en: 'No forecast data available yet — waiting for AEMO P5MIN / PREDISPATCH.',
    zh: '暂无预测数据 — 等待 AEMO P5MIN / PREDISPATCH 发布。',
  },
  'sug.empty.socLow':    {
    en: 'Battery near empty (SoC ≤ 5%) — only charge opportunities would apply, none in the current window.',
    zh: '电池接近放空（SoC ≤ 5%）— 仅可充电，但当前窗口暂无低谷时段。',
  },
  'sug.empty.socHigh':   {
    en: 'Battery near full (SoC ≥ 95%) — only discharge opportunities would apply, none in the current window.',
    zh: '电池接近充满（SoC ≥ 95%）— 仅可放电，但当前窗口暂无高峰时段。',
  },
  'sug.empty.flat':      {
    en: 'Forecast prices are flat — no peaks above p75 or troughs below p25 to trade.',
    zh: '预测价格平稳 — 无超过 P75 的高峰或低于 P25 的低谷可交易。',
  },
  'sug.empty.allPending': {
    en: 'All candidate intervals already have PENDING bids — cancel one to free a slot.',
    zh: '全部候选时段已存在待结算出价 — 取消其中一条以释放槽位。',
  },
  'sug.err.forecast':    { en: 'Forecast fetch failed',                     zh: '预测数据获取失败' },
  'sug.col.target':      { en: 'Target',                                    zh: '目标时段' },
  'sug.col.action':      { en: 'Action',                                    zh: '操作' },
  'sug.col.forecast':    { en: 'Forecast $',                                zh: '预测电价' },
  'sug.col.bid':         { en: 'Bid $',                                     zh: '出价' },
  'sug.col.mw':          { en: 'MW',                                        zh: 'MW' },
  'sug.col.est':         { en: 'Est. P&L',                                  zh: '预计盈亏' },
  'sug.actDischarge':    { en: 'Discharge',                                 zh: '放电' },
  'sug.actCharge':       { en: 'Charge',                                    zh: '充电' },
  'sug.submit':          { en: 'Submit',                                    zh: '提交' },
  'sug.submitAll':       { en: 'Submit all ({0})',                          zh: '一键提交（{0}）' },
  'sug.summary':         { en: '{0} discharge · {1} charge · est. ${2}',    zh: '放电 {0} · 充电 {1} · 预计 ${2}' },

  // Header stat pills (compact, one chip per metric).
  'sug.pill.discharge':  { en: 'Discharge',                                 zh: '放电' },
  'sug.pill.charge':     { en: 'Charge',                                    zh: '充电' },
  'sug.pill.estPnl':     { en: 'Est. P&L',                                  zh: '预计 P&L' },
  'sug.pill.fcas':       { en: 'FCAS legs',                                 zh: 'FCAS 腿' },
  'sug.pill.maxAvail':   { en: 'MaxAvail',                                  zh: '最大可用' },
  'sug.pill.default':    { en: 'Default rows',                              zh: '兜底行' },
  'sug.pill.closing':    { en: 'Gate <60s',                                 zh: '<60秒闸门' },
  'sug.pill.closed':     { en: 'Gate closed',                               zh: '已关闸' },
  'sug.pill.fit':        { en: 'Fit warn',                                  zh: '梯形警告' },
  'sug.pill.blocked':    { en: 'Blocked',                                   zh: '被阻塞' },
  // Legacy long-form copy — kept for reference but no longer rendered. The
  // help panel below replaces it with 6 themed cards.
  'sug.note.basis':      { en: '',                                              zh: '' },
  // Collapsible "How this sheet works" help — replaces the wall-of-text
  // footer with six scannable cards keyed by topic.
  'sug.help.toggle':     { en: 'How this sheet works',                          zh: '如何阅读这张表' },
  'sug.help.ladder.title': { en: '10-band price ladder',                        zh: '10 档价格阶梯' },
  'sug.help.ladder.body':  {
    en: 'Discharge climbs from a safety floor → forecast → spike-capture. Charge mirrors it from forecast trough → spike-floor. Bands clear when bid ≤ RRP (discharge) or ≥ RRP (charge). Click "10 bands ▸" on a row for the full ladder.',
    zh: '放电从安全底 → 预测价 → 尖峰捕获价递增；充电反向递增。bid ≤ RRP（放电）或 ≥ RRP（充电）的档位成交。点行内 "10 bands ▸" 查看完整阶梯。',
  },
  'sug.help.default.title': { en: 'Default coverage rows',                      zh: '兜底出价行' },
  'sug.help.default.body':  {
    en: 'Intervals with prices in the "boring" mid-range still need a bid (AEMO compliance). We submit a wide conservative ladder that only clears on a spike. Toggle "Show default rows" to inspect them.',
    zh: '价格平淡的中段时段也必须出价（AEMO 合规要求）。系统生成一条宽幅保守阶梯，只在突破时成交。点"显示兜底"查看。',
  },
  'sug.help.fcas.title':    { en: 'FCAS dual-leg co-optimisation',              zh: 'FCAS 双腿协同' },
  'sug.help.fcas.body':     {
    en: 'Every active row carries an opposite-bucket FCAS leg at full power (always fits). With "Co-opt reserve %" > 0, a same-bucket leg is added and the energy ladder shrinks proportionally so total bucket commitment ≤ unit power.',
    zh: '每条活跃行自带一条反向 FCAS 腿（一定能落单）。"协同保留 %" > 0 时追加一条同向腿，能量阶梯按比例缩小以保证总承诺 ≤ 额定功率。',
  },
  'sug.help.ramp.title':    { en: 'Ramp check',                                 zh: '爬坡校验' },
  'sug.help.ramp.body':     {
    en: 'Each row shows the MW/min swing needed from the previous interval. Rows that exceed your unit\'s ramp rate are flagged ⚠ and Submit is disabled.',
    zh: '每行显示相对上一时段的 MW/分钟切换需求。超出机组爬坡能力的行会被标记 ⚠ 并禁用提交。',
  },
  'sug.help.gate.title':    { en: 'Gate closure countdown',                     zh: '闸门倒计时' },
  'sug.help.gate.body':     {
    en: 'Each row counts down to T − 5 min (AEMO bid lockdown). ⏳ open · ⏱ closing within 60s · ⚠ closed. Closed rows dim and Submit locks — AEMO rejects post-gate calls.',
    zh: '每行倒计时至 T − 5 分钟闸门关闭。⏳ 未关 · ⏱ 60 秒内将关 · ⚠ 已关。关闸后变灰、提交锁定 —— AEMO 拒收。',
  },
  'sug.help.reason.title':  { en: 'Rebid reason (NER 3.8.22A)',                 zh: '重报原因（NER 3.8.22A）' },
  'sug.help.reason.body':   {
    en: 'INITIAL for first bid of an interval; PRICE / FORECAST / DEMAND / OUTAGE / RAMP / ENERGY_LIMIT / TEMPERATURE / STRATEGY / OTHER for rebids. Optional free-text note is appended. Audited in the bid ledger.',
    zh: '初次出价填 INITIAL；重报选 PRICE / FORECAST / DEMAND / OUTAGE / RAMP / ENERGY_LIMIT / TEMPERATURE / STRATEGY / OTHER。可附文字说明，工单留痕审计。',
  },
  'sug.ladder.title':    { en: '10-band ladder · cleared bands highlighted · click any cell to edit',
                            zh: '10 档价格阶梯 · 已成交档位高亮 · 点击单元格可编辑' },
  'sug.ladder.bands':    { en: '{0} bands',                                   zh: '{0} 档' },
  'sug.ladder.toggle':   { en: 'Click to view / edit all 10 bands',           zh: '点击查看 / 编辑 10 档明细' },
  'sug.ladder.clears':   { en: 'Clears',                                      zh: '成交' },
  'sug.ladder.reset':    { en: 'Reset to suggested',                          zh: '重置为建议值' },
  'sug.ladder.modified': { en: 'modified',                                    zh: '已修改' },
  'sug.ladder.invalid':  { en: 'fix invalid bands before submitting',         zh: '请先修正无效档位再提交' },
  'sug.ladder.totalMw':  { en: 'Σ {0} MW',                                    zh: '合计 {0} MW' },
  'sug.ladder.issueCol': { en: 'Issue',                                       zh: '问题' },
  'sug.ladder.issue.range':     { en: 'price must be in [${0}, ${1}]',        zh: '价格必须在 [${0}, ${1}]' },
  'sug.ladder.issue.mw':        { en: 'MW must be ≥ 0',                       zh: 'MW 必须 ≥ 0' },
  'sug.ladder.issue.mwNaN':     { en: 'MW must be a number',                  zh: 'MW 必须是数字' },
  'sug.ladder.issue.monotonic': { en: 'price must exceed band {0} (${1})',    zh: '价格必须高于第 {0} 档（${1}）' },

  // Ramp-rate enforcement (AEMO technical feasibility — registered ramp budget)
  'sug.ramp.label':        { en: 'Ramp:',                                       zh: '爬坡：' },
  'sug.ramp.unit':         { en: 'MW/min',                                      zh: 'MW/分' },
  'sug.ramp.reset':        { en: 'reset',                                       zh: '重置' },
  'sug.ramp.resetTitle':   { en: 'Reset to power_mw default ({0} MW/min)',      zh: '重置为额定功率默认值（{0} MW/分）' },
  'sug.ramp.inputTitle':   {
    en: 'Registered ramp rate (MW/min). Default = power_mw ({0}). Bids requiring a steeper swing than this are flagged as infeasible — AEMO would reject them.',
    zh: '注册爬坡率（MW/分）。默认 = 额定功率（{0}）。所需爬坡超过此值的出价会被标记为不可行 —— AEMO 会拒收。',
  },
  'sug.ramp.okTitle':      {
    en: 'Required {0} MW/min · within {1} MW/min ramp budget.',
    zh: '所需 {0} MW/分 · 在 {1} MW/分 爬坡预算内。',
  },
  'sug.ramp.exceedTitle':  {
    en: 'Required {0} MW/min exceeds {1} MW/min ramp budget — AEMO would reject this bid.',
    zh: '所需 {0} MW/分 超过 {1} MW/分 爬坡预算 —— AEMO 会拒收此出价。',
  },

  // Gate closure (AEMO rule: bids lock T - 5 min before each dispatch interval)
  'sug.gate.closed':       { en: 'closed',                                    zh: '已截止' },
  'sug.gate.openTitle':    {
    en: 'Gate closes {0} min before target interval — {1} remaining. Submit and cancel calls after gate close are rejected by AEMO.',
    zh: '提交闸门在目标时段前 {0} 分钟关闭 —— 剩余 {1}。AEMO 在闸门关闭后拒收任何提交或撤单。',
  },
  'sug.gate.closedTitle':  {
    en: 'Gate closed {0} ago — AEMO no longer accepts submit/cancel for this interval. The row stays visible for context but its submit button is locked.',
    zh: '闸门已于 {0} 前关闭 —— AEMO 不再接受此时段的提交或撤单。该行仅作上下文显示，提交按钮已锁定。',
  },
  'sug.gate.closingSummaryTitle': {
    en: 'Rows whose gate closes within the next 60 s — last chance to submit.',
    zh: '闸门在 60 秒内关闭的行 —— 最后提交窗口。',
  },
  'sug.gate.closedSummaryTitle': {
    en: 'Rows past the AEMO gate close — kept visible for reference but cannot be submitted.',
    zh: '已过 AEMO 闸门的行 —— 保留显示供参考，但无法提交。',
  },
  'sug.summary.closing':   { en: '· {0} closing',                              zh: '· {0} 条临近闸门' },
  'sug.summary.closed':    { en: '· {0} closed',                               zh: '· {0} 条已截止' },

  // MaxAvail (AEMO declared availability — sum of all band MW per bid)
  'sug.maxAvail.badge':    { en: 'Avail {0} MW',                               zh: '可用 {0} MW' },
  'sug.maxAvail.title':    {
    en: 'MaxAvail = sum of all bid bands ({0} MW). AEMO uses this as the upper envelope for dispatch and PASA — bands above it are ignored.',
    zh: 'MaxAvail = 所有出价档位 MW 之和（{0} MW）。AEMO 据此设定调度与 PASA 的容量上限 —— 超出此值的档位会被忽略。',
  },
  'sug.summary.maxAvail':       { en: '· Σ MaxAvail {0} MWh',                  zh: '· 合计 MaxAvail {0} MWh' },
  'sug.summary.maxAvailTitle':  {
    en: 'Total MaxAvail across visible intervals, in MWh (= MW × 5/60). What you\'re declaring to AEMO as available capacity over the horizon.',
    zh: '当前可见时段的 MaxAvail 总量（MWh = MW × 5/60）—— 即你向 AEMO 申报的整段时段可用容量。',
  },

  // MLF (Marginal Loss Factor — settlement scaling for connection-point losses)
  'sug.mlf.label':         { en: 'MLF:',                                       zh: 'MLF：' },
  'sug.mlf.inputTitle':    {
    en: 'Marginal Loss Factor (AEMO transmission-loss multiplier published per DUID, annual). GEN revenue = RRP × MWh × MLF; LOAD cost = RRP × MWh / MLF. < 1 = penalty (far from RRN), > 1 = bonus (close to RRN). Defaults to 1.00 (neutral). Look up your DUID in the AEMO MLF list.',
    zh: '边际损失因子（AEMO 按 DUID 年度发布的输电损耗系数）。GEN 收入 = RRP × MWh × MLF；LOAD 成本 = RRP × MWh / MLF。< 1 = 惩罚（远离 RRN），> 1 = 奖励（靠近 RRN）。默认 1.00（中性）。可在 AEMO MLF 清单中查询 DUID 对应值。',
  },
  'sug.mlf.resetTitle':    { en: 'Reset MLF to 1.00 (neutral)',                zh: '重置 MLF 为 1.00（中性）' },
  'sug.summary.mlf':       { en: '· MLF ×{0}',                                 zh: '· MLF ×{0}' },
  'sug.mlf.summaryTitle':  {
    en: 'MLF = {0} applied to energy legs only (FCAS is capacity payment, not loss-adjusted). Totals shown are post-MLF.',
    zh: 'MLF = {0}，仅作用于能量腿（FCAS 为容量付费，不受损耗调整）。汇总数已含 MLF。',
  },
  'sug.mlf.rowBadge':      { en: '× MLF {0}',                                  zh: '× MLF {0}' },
  'sug.mlf.rowTitle':      {
    en: 'Energy P&L pre-MLF: {0} → × MLF {1} → {2}',
    zh: '能量 P&L 调整前：{0} → × MLF {1} → {2}',
  },

  // Rebid reason (AEMO NER 3.8.22A — every rebid must carry a brief, verifiable reason)
  'sug.reason.label':         { en: 'Reason:',                                  zh: '原因：' },
  'sug.reason.notePh':        { en: 'optional detail…',                         zh: '可选补充说明…' },
  'sug.reason.noteTitle':     {
    en: 'Free-text detail appended to the reason code (max 128 chars). AEMO rebid reasons must be brief but verifiable — e.g. "AEMO P5MIN revised peak +$120".',
    zh: '附加到原因码之后的自由文本说明（最多 128 字）。AEMO 要求重报原因简洁可核 —— 例如 "AEMO P5MIN 修正峰价 +$120"。',
  },
  'sug.reason.inputTitle':    {
    en: 'AEMO standard rebid reason category. NER 3.8.22A requires every bid (and especially every rebid) to declare why it was submitted. Carried into the bid notes prefix and visible in the ledger for audit.',
    zh: 'AEMO 标准重报原因分类。NER 3.8.22A 规定每条出价（尤其是重报）必须附原因。该值将作为前缀写入出价 notes，并在工单中可查询作为审计依据。',
  },
  'sug.reason.summary':       { en: '· reason {0}',                              zh: '· 原因 {0}' },
  'sug.reason.summaryTitle':  {
    en: 'All submits in this session are tagged with reason code "{0}". Change above before submitting to apply a different category.',
    zh: '本次会话所有提交将打上原因码 "{0}"。如需改用其他分类，请在顶部修改后再提交。',
  },
  // Reason code labels (kept short for the dropdown)
  'sug.reason.INITIAL':       { en: 'INITIAL · first bid',                       zh: 'INITIAL · 初始出价' },
  'sug.reason.PRICE':         { en: 'PRICE · price-driven',                      zh: 'PRICE · 价格驱动' },
  'sug.reason.FORECAST':      { en: 'FORECAST · forecast revision',              zh: 'FORECAST · 预测修订' },
  'sug.reason.DEMAND':        { en: 'DEMAND · demand revision',                  zh: 'DEMAND · 负荷修订' },
  'sug.reason.OUTAGE':        { en: 'OUTAGE · availability change',              zh: 'OUTAGE · 可用性变化' },
  'sug.reason.RAMP':          { en: 'RAMP · ramp-rate change',                   zh: 'RAMP · 爬坡率变化' },
  'sug.reason.ENERGY_LIMIT':  { en: 'ENERGY_LIMIT · SoC / fuel cap',             zh: 'ENERGY_LIMIT · SoC / 燃料限制' },
  'sug.reason.TEMPERATURE':   { en: 'TEMPERATURE · ambient',                     zh: 'TEMPERATURE · 环境温度' },
  'sug.reason.STRATEGY':      { en: 'STRATEGY · bidding strategy',               zh: 'STRATEGY · 出价策略' },
  'sug.reason.OTHER':         { en: 'OTHER · see note',                          zh: 'OTHER · 详见备注' },

  // Co-opt bucket fit (existing PENDING commitments → shrink suggestion legs)
  'sug.fit.badge':            { en: 'used {0} MW',                              zh: '已占 {0} MW' },
  'sug.fit.shrunk':           { en: 'fit',                                      zh: '已缩' },
  'sug.fit.yes':              { en: 'yes',                                      zh: '是' },
  'sug.fit.no':               { en: 'no',                                       zh: '否' },
  'sug.fit.title':            {
    en: 'Interval already has PENDING bids: upward bucket {0} MW · downward bucket {1} MW. Suggestion was sized down to fit AEMO\'s co-opt envelope (bucket sum ≤ power_mw). Energy ladder shrunk: {2}. Opp FCAS leg capped: {3}. Same FCAS leg capped: {4}.',
    zh: '本时段已有 PENDING 出价：upward 桶 {0} MW · downward 桶 {1} MW。建议已自动缩减以满足 AEMO 协同约束（桶总和 ≤ 额定功率）。能量阶梯缩减：{2}。反向 FCAS 腿封顶：{3}。同向 FCAS 腿封顶：{4}。',
  },
  'sug.fit.summary':          { en: '· {0} fit',                                 zh: '· {0} 条已缩' },
  'sug.fit.summaryTitle':     {
    en: 'Rows where the suggestion was shrunk to fit pre-existing PENDING bids in the same interval — avoids the backend co-opt rejection ("upward/downward commitments would total X > Y MW power").',
    zh: '本时段已存在 PENDING 出价、建议已按桶剩余空间缩减的行数 —— 避免后端协同检查报错 ("upward/downward commitments would total X > Y MW power")。',
  },
  'sug.fit.blocked':          { en: '· {0} blocked',                             zh: '· {0} 条全占用' },
  'sug.fit.blockedTitle':     {
    en: 'Rows entirely dropped because the energy bucket was 100% pre-committed by existing PENDING bids. Cancel one of the existing bids for that interval to free room.',
    zh: '能量桶已被 PENDING 出价占满、建议无法插入而整行丢弃。可在工单中取消该时段的现有出价以腾出空间。',
  },

  // Default coverage (AEMO compliance — bid required for every dispatch interval)
  'sug.coverage.default':       { en: 'DEF',                                   zh: '兜底' },
  'sug.coverage.defaultTitle':  {
    en: 'Default coverage: conservative bid for AEMO compliance — only clears at extreme prices outside the active-trade band.',
    zh: '兜底覆盖：AEMO 合规所需的保守出价 —— 仅在超出主动交易区间的极端电价下成交。',
  },
  'sug.toggle.showDefaults':    { en: 'Show {0} default rows',                 zh: '显示 {0} 条兜底' },
  'sug.summary.default':        { en: '· {0} default',                          zh: '· {0} 条兜底' },
  'sug.diag.defaults':          { en: 'middle (default cover): {0}',            zh: '中段（兜底覆盖）：{0}' },
  'sug.empty.activeOnly':       {
    en: '{0} default-coverage rows hidden — toggle "Show default rows" to view them.',
    zh: '{0} 条兜底覆盖行已隐藏 —— 勾选"显示兜底"查看。',
  },

  // FCAS co-optimisation legs (AEMO trapezium — dual leg)
  'sug.fcas.title':       { en: 'FCAS legs · co-optimised',                   zh: 'FCAS 协同腿' },
  'sug.fcas.badge':       { en: '+F',                                          zh: '+F' },
  'sug.fcas.badgeTitle':  { en: 'Includes FCAS leg: {0} @ ${1}/MW/h',          zh: '附带 FCAS 协同腿：{0} @ ${1}/MW/h' },
  'sug.fcas.badgeTitleLeg': { en: '{0} · {1} @ ${2}/MW/h · {3} MW',           zh: '{0} · {1} @ ${2}/MW/h · {3} MW' },
  'sug.fcas.legOpposite':     { en: 'opposite',                                zh: '反向' },
  'sug.fcas.legSame':         { en: 'same',                                    zh: '同向' },
  'sug.fcas.legOppositeHint': {
    en: 'Opposite bucket — empty after the energy bid; full nameplate available. Always fits.',
    zh: '反向桶 —— 能量出价占用对面方向，本桶为空，可用全部额定功率。一定能落单。',
  },
  'sug.fcas.legSameHint': {
    en: 'Same bucket as energy — only fits because the trapezium reserve % shrunk the energy ladder. Size = power × reserve%.',
    zh: '与能量同桶 —— 仅当梯形协同保留 % > 0 时（能量阶梯按比例缩减）才有容量。容量 = 额定功率 × 保留%。',
  },
  'sug.fcas.detail':      { en: '{0} MW @ bid ${1} · forecast ${2}/MW/h',     zh: '{0} MW @ 出价 ${1} · 预测 ${2}/MW/h' },
  'sug.fcas.none':        { en: 'No eligible FCAS market in this interval forecast (all below $0.50/MW/h threshold).',
                             zh: '本时段无符合条件的 FCAS 市场（均低于 $0.50/MW/h 阈值）。' },
  'sug.fcas.split':       { en: 'E {0} · F {1}',                                zh: '能 {0} · F {1}' },
  'sug.summary.fcas':     { en: '+ {0} FCAS legs',                              zh: '+ {0} 条 FCAS 腿' },

  // FCAS trapezium reserve % (header co-opt control)
  'sug.coopt.label':       { en: 'Co-opt reserve:',                            zh: '协同保留：' },
  'sug.coopt.unit':        { en: '%',                                          zh: '%' },
  'sug.coopt.inputTitle':  {
    en: 'AEMO trapezium reserve %. Shrinks the energy ladder by this % and offers the freed capacity ({0} MW) as a SAME-direction FCAS leg. 0 = pure energy + opposite-leg only. 20-30% trades energy throughput for additional FCAS revenue on both directions.',
    zh: 'AEMO 梯形协同保留比例。能量阶梯按此比例缩减，腾出 {0} MW 容量挂为同向 FCAS 腿。0 = 纯能量出价 + 反向 FCAS。20-30% 牺牲少量能量吞吐换取双向 FCAS 收益。',
  },

  // Map hovers / legend
  'map.online':          { en: 'online',                                   zh: '在线' },
  'map.offline':         { en: 'offline',                                  zh: '离线' },
  'map.units':           { en: 'units',                                    zh: '机组' },
  'map.exportLimit':     { en: 'Export limit',                             zh: '正向限额' },
  'map.importLimit':     { en: 'Import limit',                             zh: '反向限额' },
  'map.flow':            { en: 'Flow',                                     zh: '潮流' },
  'map.limit':           { en: 'Limit',                                    zh: '限额' },
  'map.util':            { en: 'Util',                                     zh: '利用率' },
  'map.utilisation':     { en: 'Utilisation',                              zh: '利用率' },
  'map.now':             { en: 'Now',                                      zh: '当前' },
  'map.capacity':        { en: 'Capacity',                                 zh: '容量' },
  'map.fuel':            { en: 'Fuel',                                     zh: '燃料' },
  'map.transmission':    { en: 'Transmission',                             zh: '输电线' },
  'map.substation':      { en: 'Substation',                                zh: '变电站' },
  'map.zoomToSee':       { en: 'zoom in',                                   zh: '放大可见' },

  // Live fuel-mix section (FuelMixLive component).
  'fuelmix.title':       { en: 'Live fuel mix · last 6 h',                  zh: '实时燃料构成 · 最近 6 小时' },
  'fuelmix.hint':        {
    en: 'Each band ebbs and flows with current generation per source. Coal holds the floor; renewables ride the top.',
    zh: '每条带状显示各燃料的实时出力此消彼长。煤电稳定打底,新能源在上方起伏。',
  },
  'fuelmix.kicker':      { en: '{0} · generating now',                      zh: '{0} · 当前发电' },
  'fuelmix.now':         { en: 'right now',                                  zh: '当前' },
  'fuelmix.noData':      { en: 'No fuel-mix data yet — waiting for SCADA…',  zh: '暂无燃料构成数据 — 等待 SCADA…' },
  'fuelmix.err':         { en: 'Fuel mix unavailable —',                     zh: '燃料构成暂不可用 ——' },
  'fuelmix.trends':      { en: '6-hour trend · now · vs 6h ago',              zh: '6 小时走势 · 当前 · 相对 6h 前' },
  'map.zoom.in':         { en: 'Zoom in',                                  zh: '放大' },
  'map.zoom.out':        { en: 'Zoom out',                                 zh: '缩小' },
  'map.zoom.reset':      { en: 'Reset view',                               zh: '重置视图' },
  'map.bess':            { en: 'BESS',                                     zh: 'BESS' },
  'map.interconnector':  { en: 'Interconnector',                           zh: '联络线' },
  'map.clickHint':       { en: 'Click a state to focus the price chart',   zh: '点击州可聚焦电价曲线' },

  // Price chart
  'chart.loading':       { en: 'Loading…',                                 zh: '加载中…' },
  'chart.noData':        { en: 'No data yet — waiting for next dispatch interval.', zh: '暂无数据 — 等待下一调度间隔。' },
  'chart.rrp':           { en: 'RRP (actual)',                             zh: 'RRP（实际）' },
  'chart.forecast':      { en: 'RRP (AEMO forecast)',                      zh: 'RRP（AEMO 预测）' },
  'chart.demand':        { en: 'Demand (actual)',                          zh: '负荷（实际）' },
  'chart.forecastDemand': { en: 'Demand (forecast)',                       zh: '负荷（预测）' },
  'chart.now':           { en: 'now',                                      zh: '当前' },
  'chart.binding':       { en: 'Binding constraint',                       zh: '约束生效' },

  // KPI strip above the chart
  'kpi.spot':            { en: 'Spot price',                               zh: '现货电价' },
  'kpi.demand':          { en: 'Demand',                                   zh: '负荷' },
  'kpi.forecastPrice':   { en: 'Forecast · next interval',                 zh: '预测 · 下一时段' },
  'kpi.forecastDemand':  { en: 'Forecast demand · next',                   zh: '预测负荷 · 下一时段' },
  'kpi.vintage':         { en: 'issued {0} min ago',                       zh: '{0} 分钟前发布' },
  'kpi.apc':             { en: 'Admin price cap',                          zh: '管制电价上限' },
  'kpi.apc.inactive':    { en: 'INACTIVE',                                 zh: '未触发' },
  'kpi.apc.note':        { en: 'NEM-wide $600/MWh once CPT breached',      zh: '累计电价阈值触发时 $600/MWh 生效' },

  // Heat map
  'sec.heatmap':         { en: 'Daily peak heatmap · last 90 days',        zh: '日峰值热力图 · 近 90 天' },
  'sec.heatmapHint':     {
    en: 'Each cell = one day. Orange = above the 90-day mean of daily peaks; grey = below. Read across to spot heatwave or scarcity clusters.',
    zh: '每格代表一天。橙色表示当日峰值高于近 90 天均值，灰色为低于均值。横向阅读可发现热浪或紧缺时段。',
  },
  'heatmap.energy':      { en: 'Energy · daily peak $/MWh',                zh: '能量 · 日峰值 $/MWh' },
  'heatmap.fcas':        { en: 'Raise Regulation · daily peak $/MW/h',     zh: '上调调频 · 日峰值 $/MW/h' },
  'heatmap.mean':        { en: 'mean',                                     zh: '均值' },
  'heatmap.noData':      { en: 'No data yet.',                             zh: '暂无数据。' },
  'heatmap.legend.below': { en: '↓ below mean',                            zh: '↓ 低于均值' },
  'heatmap.legend.above': { en: '↑ above mean',                            zh: '↑ 高于均值' },
  'heatmap.legend.energyRamp': { en: 'Energy peak',                        zh: '能量峰值' },
  'heatmap.legend.fcasRamp':   { en: 'Raise Reg peak',                     zh: '上调调频峰值' },
  'heatmap.legend.nodata': { en: 'no data',                                zh: '暂无数据' },
  'heatmap.cell':        { en: '{0} · {1} · ${2}',                         zh: '{0} · {1} · ${2}' },
  'heatmap.tip.energyPeak': { en: 'Energy peak',                            zh: '能量峰值' },
  'heatmap.tip.fcasPeak':   { en: 'Raise Reg peak',                         zh: '上调调频峰值' },
  'heatmap.tip.vsMean':     { en: 'vs 90-day mean',                         zh: '相对 90 天均值' },
  'heatmap.tip.noData':     { en: 'no data',                                zh: '暂无数据' },

  // NSW deep dive — map header & legend
  'nsw.mapTitle':        { en: 'New South Wales · live grid',              zh: '新南威尔士 · 实时电网' },
  'nsw.mapHint':         {
    en: 'Generators by fuel · BESS state · interconnector flows to neighbouring regions',
    zh: '机组按燃料分类 · BESS 状态 · 与邻区的联络线潮流',
  },
  'nsw.mwSuffix':        { en: 'MW',                                       zh: 'MW' },
  'nsw.demandSuffix':    { en: 'demand',                                   zh: '负荷' },
  'nsw.noLiveGen':       { en: 'No live generation data yet.',             zh: '暂无实时发电数据。' },
  'nsw.netIcInflow':     { en: 'Net IC inflow',                            zh: '联络线净流入' },

  // BESS card — extended
  'bess.watch':          { en: 'BESS watch',                               zh: 'BESS 观察' },
  'bess.noNswBattery':   { en: 'No NSW battery in registry.',              zh: '注册表中无 NSW 电池。' },
  'bess.nameplate':      { en: 'MW nameplate',                             zh: 'MW 额定容量' },
  'bess.power':          { en: 'Power',                                    zh: '功率' },
  'bess.utilisation':    { en: 'Utilisation',                              zh: '利用率' },
  'bess.chargeLeft':     { en: '−{0} MW (charge)',                         zh: '−{0} MW（充电）' },
  'bess.dischargeRight': { en: '+{0} MW (discharge)',                      zh: '+{0} MW（放电）' },
  'bess.demoNote':       {
    en: 'Default headline asset for the NSW arbitrage demo. The bidding console lets you submit paper-trading orders against this DUID and track P&L vs actual dispatch.',
    zh: 'NSW 套利演示的默认主力资产。出价控制台可向该 DUID 提交模拟出价，并对照实际调度跟踪 P&L。',
  },

  // Bid form — extended
  'bid.titleFor':        { en: 'Submit bid · {0}',                         zh: '提交出价 · {0}' },
  'bid.intervalSuffix':  { en: '+{0}min',                                  zh: '+{0} 分钟' },
  'bid.totalLabel':      { en: 'Σ {0} / {1} MW',                           zh: '合计 {0} / {1} MW' },

  // Position card — extended
  'pos.titleFor':        { en: 'Position · {0}',                           zh: '持仓 · {0}' },
  'pos.lastSettledFmt':  { en: 'Last settled: {0} NEM',                    zh: '上次结算：{0} NEM' },
  'pos.socUnit':         { en: '{0} / {1} MWh',                            zh: '{0} / {1} MWh' },
  'pos.socMeta':         { en: '{0}% · {1} MW · {2}% RTE',                 zh: '{0}% · {1} MW · {2}% RTE' },
  'pos.mlf':             { en: 'MLF {0}',                                   zh: 'MLF {0}' },
  'pos.mlfTitle':        { en: 'Marginal Loss Factor. GEN revenue × MLF; LOAD cost ÷ MLF. FCAS is unaffected.',
                           zh: '边际损失因子。卖电收入 × MLF；买电成本 ÷ MLF。FCAS 不受影响。' },

  // Common
  'common.loading':      { en: 'Loading…',                                 zh: '加载中…' },

  // ===== BESS-Calc =======================================================
  // Input cards
  'bc.in.asset':         { en: 'Asset',                                    zh: '资产' },
  'bc.in.capital':       { en: 'Capital structure',                        zh: '融资结构' },
  'bc.in.revenue':       { en: 'Revenue assumptions',                      zh: '收益假设' },
  'bc.in.engineering':   { en: 'Engineering',                              zh: '工程参数' },
  'bc.in.financial':     { en: 'Financial',                                zh: '财务参数' },
  'bc.in.region':        { en: 'Region',                                   zh: '区域' },
  'bc.in.powerMw':       { en: 'Power',                                    zh: '功率' },
  'bc.in.duration':      { en: 'Duration',                                 zh: '时长' },
  'bc.in.energyMwh':     { en: 'Energy',                                   zh: '能量' },
  'bc.in.capex':         { en: 'Total CapEx',                              zh: '总 CapEx' },
  'bc.in.costRegime':    { en: 'CapEx cost decomposition',                 zh: 'CapEx 成本拆解' },
  'bc.in.powerCost':     { en: 'Power-related cost',                       zh: '功率成本' },
  'bc.in.energyCost':    { en: 'Energy-related cost',                      zh: '能量成本' },
  'bc.in.fixedCapex':    { en: 'Fixed (grid + civils)',                    zh: '固定(并网+土建)' },
  'bc.regime.low':       { en: 'Low',                                      zh: '低' },
  'bc.regime.mid':       { en: 'Mid',                                      zh: '中' },
  'bc.regime.high':      { en: 'High',                                     zh: '高' },
  'bc.regime.note':      {
    en: 'Mid = AEMO ISP 2024-25 NSW tier-1 EPC anchor. CapEx auto-tracks (MW × $/kW) + (MWh × $/kWh) + fixed.',
    zh: '中档 = AEMO ISP 2024-25 NSW 一线 EPC 锚点。CapEx 自动 = (MW × $/kW) + (MWh × $/kWh) + 固定。',
  },
  'bc.capex.derived':    { en: 'AUTO from scale',                          zh: '按规模自动推导' },
  'bc.capex.override':   { en: 'MANUALLY OVERRIDDEN',                      zh: '已手动覆盖' },
  'bc.capex.wouldBe':    { en: 'derived would be',                         zh: '若自动推导 =' },
  'bc.capex.power':      { en: 'Power',                                    zh: '功率部分' },
  'bc.capex.energy':     { en: 'Energy',                                   zh: '能量部分' },
  'bc.capex.fixed':      { en: 'Fixed',                                    zh: '固定' },

  // Backtest panel
  'bc.bt.spec':          { en: '{0} / {1} · {2} RTE · {3}×/day',           zh: '{0} / {1} · RTE {2} · 每天 {3} 次循环' },
  'bc.bt.window':        { en: 'Lookback',                                  zh: '回测窗口' },
  'bc.bt.energy':        { en: 'Energy arbitrage',                         zh: '能量套利' },
  'bc.bt.fcas':          { en: 'FCAS',                                      zh: 'FCAS' },
  'bc.bt.impliedSpread': { en: 'Implied spread',                           zh: '隐含价差' },
  'bc.bt.impliedPerMw':  { en: 'Implied per-MW',                           zh: '隐含 per-MW' },
  'bc.bt.capture':       { en: 'Capture',                                  zh: '捕获率' },
  'bc.bt.bestDay':       { en: 'Best day',                                 zh: '最佳单日' },
  'bc.bt.monthly':       { en: 'Monthly revenue (Energy + FCAS)',          zh: '逐月收益(能量 + FCAS)' },
  'bc.bt.useValues':     { en: '↺ Use backtested values',                  zh: '↺ 用回测值替换上方手动输入' },
  'bc.bt.running':       { en: 'Running backtest…',                        zh: '回测计算中…' },
  'bc.bt.waiting':       { en: 'Backtest will run automatically when spec is set.', zh: '设置参数后会自动回测。' },
  'bc.bt.methodology':   {
    en: 'Each day in window: simulate BESS dispatch at top × cycles intervals (sell) + bottom × cycles intervals (buy), apply √RTE charge multiplier + MLF + capture efficiency. FCAS = annual sum of 10-market RRPs × utilisation. Spike days drive most of NSW BESS revenue — backtest captures them, "median × cycles" doesn\'t.',
    zh: '逐日仿真:在当天最贵 N 个 5min 区间卖电 + 最便宜 N 个区间买电(N = cycles × duration × 12),按 √RTE 加充电倍数 + MLF + 捕获率。FCAS = 10 市场年总和 × 利用率。NSW BESS 收入大头来自尖峰日 — 回测捕获,中位数 × 循环不行。',
  },
  'bc.bt.cycleHist':     { en: 'Cycle distribution',                        zh: '循环次数分布' },
  'bc.bt.idle':          { en: 'd idle (spread < deg cost)',                zh: 'd 无交易(价差 < 降解成本)' },
  'bc.wf.title':         { en: 'Spread waterfall ($/MWh discharged)',       zh: '价差瀑布图 ($/MWh 放电)' },
  'bc.wf.gross':         { en: 'Gross market spread',                       zh: '市场原始价差' },
  'bc.wf.afterRte':      { en: 'After RTE losses',                         zh: '扣 RTE 损耗后' },
  'bc.wf.afterMlf':      { en: 'After MLF + aux',                          zh: '扣 MLF + 自用电后' },
  'bc.wf.afterCapture':  { en: 'Net (after capture eff.)',                  zh: '净值(扣捕获率后)' },
  'bc.wf.hint':          { en: '',                                          zh: '' },
  'bc.in.debtPct':       { en: 'Debt %',                                   zh: '贷款比例' },
  'bc.in.rate':          { en: 'Interest',                                 zh: '利率' },
  'bc.in.tenor':         { en: 'Loan tenor',                               zh: '贷款年限' },
  'bc.in.life':          { en: 'Project life',                             zh: '项目年限' },
  'bc.in.arbSpread':     { en: 'Energy arb spread',                        zh: '套利价差' },
  'bc.in.fcasRev':       { en: 'FCAS revenue (yr1)',                       zh: 'FCAS 收益(首年)' },
  'bc.in.fcasDecline':   { en: 'FCAS decline',                             zh: 'FCAS 年衰减' },
  'bc.in.cis':           { en: 'CIS floor revenue',                        zh: 'CIS 保底收益' },
  'bc.in.rte':           { en: 'RTE',                                      zh: '往返效率' },
  'bc.in.cycles':        { en: 'Cycles',                                   zh: '循环' },
  'bc.in.degrad':        { en: 'Degradation',                              zh: '电池衰减' },
  'bc.in.mlf':           { en: 'MLF',                                      zh: 'MLF' },
  'bc.in.augPct':        { en: 'Augmentation %',                           zh: '增补比例' },
  'bc.in.augYr':         { en: 'Aug. year',                                zh: '增补年份' },
  'bc.in.opex':          { en: 'O&M cost',                                 zh: '运维成本' },
  'bc.in.insurance':     { en: 'Insurance',                                zh: '保险' },
  'bc.in.wacc':          { en: 'WACC',                                     zh: '折现率' },
  'bc.in.tax':           { en: 'Tax rate',                                 zh: '税率' },
  'bc.in.inflation':     { en: 'Inflation',                                zh: '通胀' },
  'bc.in.deprLife':      { en: 'Depreciation life',                        zh: '折旧年限' },
  'bc.in.reset':         { en: 'Reset to defaults',                        zh: '重置为默认值' },

  // KPI cards
  'bc.kpi.kicker':       { en: 'PROJECT FINANCE',                          zh: '项目融资' },
  'bc.kpi.title':        {
    en: '{0} / {1} BESS in {2}',
    zh: '{0} / {1} BESS @ {2}',
  },
  'bc.kpi.attractive':   { en: 'ATTRACTIVE',                               zh: '具吸引力' },
  'bc.kpi.marginal':     { en: 'MARGINAL',                                 zh: '勉强可投' },
  'bc.kpi.weak':         { en: 'WEAK',                                     zh: '不达标' },
  'bc.kpi.computing':    { en: 'recomputing…',                             zh: '重新计算…' },
  'bc.kpi.npv':          { en: 'NPV',                                      zh: 'NPV' },
  'bc.kpi.projIrr':      { en: 'Project IRR',                              zh: '项目 IRR' },
  'bc.kpi.eqIrr':        { en: 'Equity IRR',                               zh: '股本 IRR' },
  'bc.kpi.payback':      { en: 'Payback',                                  zh: '回本期' },
  'bc.kpi.lcos':         { en: 'LCOS',                                     zh: 'LCOS' },
  'bc.kpi.dscr':         { en: 'Min DSCR',                                 zh: '最低 DSCR' },
  'bc.kpi.debtAmt':      { en: 'Debt',                                     zh: '债务' },
  'bc.kpi.eqAmt':        { en: 'Equity',                                   zh: '股本' },
  'bc.kpi.annualDS':     { en: 'Annual debt service',                      zh: '年还本付息' },
  'bc.kpi.totalRev':     { en: 'Lifetime revenue',                         zh: '生命周期总收益' },
  'bc.kpi.totalOpex':    { en: 'Lifetime OpEx',                            zh: '生命周期总运维' },
  'bc.kpi.totalMwh':     { en: 'Lifetime MWh',                             zh: '生命周期总放电' },

  // Revenue chart
  'bc.rev.kicker':       { en: 'REVENUE STACK',                            zh: '收益结构' },
  'bc.rev.title':        { en: 'Annual revenue by stream',                 zh: '年度收益按渠道拆分' },
  'bc.rev.energy':       { en: 'Energy arb',                               zh: '能量套利' },
  'bc.rev.fcas':         { en: 'FCAS',                                     zh: 'FCAS' },
  'bc.rev.cis':          { en: 'CIS',                                      zh: 'CIS' },
  'bc.rev.note':         {
    en: 'Energy declines with battery degradation; FCAS declines as the market saturates with BESS.',
    zh: '能量收益随电池衰减下降;FCAS 随市场饱和年降。',
  },

  // Tornado
  'bc.torn.kicker':      { en: 'SENSITIVITY',                              zh: '敏感性分析' },
  'bc.torn.title':       { en: 'Tornado — Equity IRR drivers',             zh: 'Tornado · Equity IRR 驱动因子' },
  'bc.torn.hint':        {
    en: 'Base equity IRR = {0}%. Each driver varied independently; bar shows IRR range across ±X% input swing.',
    zh: '基础 Equity IRR = {0}%。每个因子独立波动,条形显示对应 IRR 区间。',
  },

  // DSCR
  'bc.dscr.kicker':      { en: 'BANKABILITY',                              zh: '可融资性' },
  'bc.dscr.title':       { en: 'Debt service coverage ratio',              zh: '偿债覆盖率 (DSCR)' },
  'bc.dscr.hint':        { en: 'Banks typically require ≥ 1.3x',           zh: '银行普遍要求 ≥ 1.3x' },

  // Cashflow table
  'bc.cf.kicker':        { en: 'CASHFLOW',                                 zh: '现金流' },
  'bc.cf.title':         { en: 'Year-by-year ($k AUD)',                    zh: '逐年现金流 (千 AUD)' },
  'bc.cf.note':          {
    en: 'Equity cashflow = EBITDA − tax − CapEx − debt service. Cumulative goes positive when payback is reached.',
    zh: 'Equity 现金流 = EBITDA − 税 − CapEx − 还本付息。累计转正即达到回本。',
  },

  // Provenance
  'bc.prov.kicker':      { en: 'TRANSPARENCY',                             zh: '透明度' },
  'bc.prov.title':       { en: 'Where each assumption came from',          zh: '每个假设的来源' },
  'bc.prov.hint':        {
    en: 'Honest disclosure: which inputs are derived from real NEM data, which are industry defaults, which come from ATO/AEMO regulation.',
    zh: '诚实声明:哪些参数取自真实 NEM 数据,哪些是行业默认,哪些来自 ATO/AEMO 规则。',
  },
}

// ---- Provider + hook -----------------------------------------------------

type Ctx = {
  lang: Lang
  setLang: (l: Lang) => void
  t: (key: string, ...args: (string | number)[]) => string
}

const LangContext = createContext<Ctx | null>(null)

export function LangProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(() => {
    if (typeof window === 'undefined') return 'en'
    const saved = window.localStorage.getItem(STORAGE_KEY) as Lang | null
    if (saved === 'en' || saved === 'zh') return saved
    // Best-effort browser default.
    const nav = window.navigator?.language?.toLowerCase() ?? ''
    return nav.startsWith('zh') ? 'zh' : 'en'
  })

  const setLang = useCallback((l: Lang) => {
    setLangState(l)
    try { window.localStorage.setItem(STORAGE_KEY, l) } catch {}
  }, [])

  // Keep <html lang> in sync so screen readers + dev-tools reflect the choice.
  useEffect(() => {
    if (typeof document !== 'undefined') document.documentElement.lang = lang
  }, [lang])

  const t = useCallback((key: string, ...args: (string | number)[]) => {
    const entry = DICT[key]
    let s = entry ? entry[lang] : key
    // Simple {0}, {1} interpolation for messages with arguments.
    args.forEach((v, i) => { s = s.replace(`{${i}}`, String(v)) })
    return s
  }, [lang])

  const value = useMemo(() => ({ lang, setLang, t }), [lang, setLang, t])
  return <LangContext.Provider value={value}>{children}</LangContext.Provider>
}

export function useT(): Ctx {
  const ctx = useContext(LangContext)
  if (!ctx) throw new Error('useT must be inside <LangProvider>')
  return ctx
}
