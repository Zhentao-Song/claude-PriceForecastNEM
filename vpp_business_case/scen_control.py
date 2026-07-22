# -*- coding: utf-8 -*-
import pandas as pd, numpy as np, json, os
ROOT="/sessions/funny-upbeat-darwin/mnt/claude-PriceForecastNEM"
RT_EFF=0.90; DEGR=50.0; ARB_SEASONAL=0.80; FORESIGHT=0.85
FCAS_SEASONAL=0.90; FCAS_AVAIL=0.50; OP=0.30; DAYS=365
BK=215.0; BP=100.0  # C&I 215kWh/100kW
WORK_START,WORK_END=8,17
FCAS_COLS=["RAISE6SECRRP","RAISE60SECRRP","RAISE5MINRRP","RAISEREGRRP",
           "LOWER6SECRRP","LOWER60SECRRP","LOWER5MINRRP","LOWERREGRRP"]

df=pd.read_parquet(f"{ROOT}/data/cache/dispatch_prices.parquet")
df=df[(df.REGIONID=="NSW1")&(df.INTERVENTION==0)].copy()
df["SETTLEMENTDATE"]=pd.to_datetime(df.SETTLEMENTDATE)
df=df.sort_values("SETTLEMENTDATE")
df["date"]=df.SETTLEMENTDATE.dt.date; df["hour"]=df.SETTLEMENTDATE.dt.hour; df["wd"]=df.SETTLEMENTDATE.dt.weekday
ndays=df.date.nunique(); int_per_day=len(df)/ndays

def day_arb(prices,bk,bp,eff,degr,maxc):
    e=bp*(5/60); ndis=int(np.ceil(bk/e)); nch=int(np.ceil((bk/eff)/e))
    p=np.sort(np.asarray(prices))
    if len(p)<ndis+nch: return 0.0,0.0
    g=0.0; dm=0.0; lo,hi=0,len(p); ep=e/1000.0
    for _ in range(maxc):
        cp=p[lo:lo+nch]; dp=p[hi-ndis:hi]
        prof=dp.sum()*ep-cp.sum()*ep; dmwh=ndis*ep
        if prof-degr*dmwh>0:
            g+=prof; dm+=dmwh; lo+=nch; hi-=ndis
            if hi-lo<ndis+nch: break
        else: break
    return g,dm

def run(mode, maxc):
    arb=[]; dmwh=[]; ctrl_int=0
    for d,gg in df.groupby("date"):
        g=gg
        if mode=="nonwork":
            blk=(g.wd<5)&(g.hour>=WORK_START)&(g.hour<WORK_END)
            g=g[~blk]
        ctrl_int+=len(g)
        pr,dm=day_arb(g.RRP.values,BK,BP,RT_EFF,DEGR,maxc)
        arb.append(pr); dmwh.append(dm)
    arb_year=np.mean(arb)*DAYS*ARB_SEASONAL*FORESIGHT
    # FCAS: controllable, non-arbitrage intervals
    e=BP*(5/60); occ=int(np.ceil(BK/e))+int(np.ceil((BK/RT_EFF)/e))
    ctrl_per_day=ctrl_int/ndays
    avail_frac=max(0.0,(ctrl_per_day-occ)/int_per_day)
    # use controllable intervals' fcas stack mean
    if mode=="nonwork":
        blk=(df.wd<5)&(df.hour>=WORK_START)&(df.hour<WORK_END); fdf=df[~blk]
    else: fdf=df
    stack=fdf[FCAS_COLS].sum(axis=1).values
    mw=BP/1000.0
    fcas_daily=(mw*stack*(5/60)*FCAS_AVAIL).sum()/ndays
    # scale by share of capacity not occupied by arb (avail_frac already ~ controllable share)
    fcas_year=fcas_daily*DAYS*FCAS_SEASONAL
    return dict(arb=round(arb_year), fcas=round(fcas_year), vpp=round(arb_year+fcas_year),
                op=round((arb_year+fcas_year)*OP), ctrl_h=round(ctrl_per_day*5/60,1))

res={}
for mode in ("full","nonwork"):
    res[mode]={ "1cyc":run(mode,1), "2cyc":run(mode,2) }

print(json.dumps(res,indent=2,ensure_ascii=False))
f=res["full"]["1cyc"]; n=res["nonwork"]["1cyc"]
print("\n=== 单站·年 (1循环, A$) ===")
print(f"全天24h代理 : 套利 {f['arb']:>6} + FCAS {f['fcas']:>5} = VPP {f['vpp']:>6} | 运营商 {f['op']}")
print(f"仅非工作时段: 套利 {n['arb']:>6} + FCAS {n['fcas']:>5} = VPP {n['vpp']:>6} | 运营商 {n['op']}")
print(f"差额        : VPP +{f['vpp']-n['vpp']} ({(f['vpp']/n['vpp']-1)*100:.0f}%更高) | 运营商 +{f['op']-n['op']}")
print(f"可控时长/天 : 全天 {f['ctrl_h']}h vs 非工作 {n['ctrl_h']}h")
