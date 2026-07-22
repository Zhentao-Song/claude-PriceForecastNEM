# -*- coding: utf-8 -*-
"""Charts for the 3-page VPP deck — palette: white / grey #F5F5F5 / orange #FE4400."""
import pandas as pd, numpy as np, os
import matplotlib; matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib import font_manager as fm

ROOT = "/sessions/funny-upbeat-darwin/mnt/claude-PriceForecastNEM"
OUT  = os.path.join(ROOT, "vpp_business_case"); CH = os.path.join(OUT,"charts"); os.makedirs(CH, exist_ok=True)
fp = "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"
fm.fontManager.addfont(fp); plt.rcParams["font.family"]=fm.FontProperties(fname=fp).get_name()
plt.rcParams["axes.unicode_minus"]=False

ORANGE="#FE4400"; ORANGE_L="#FF9D7A"; INK="#222222"; MUTE="#777777"
AGREY="#B7B7B7"; GRIDC="#E6E6E6"; DARK="#3A3A3A"

res = pd.read_csv(os.path.join(OUT,"results.csv")).set_index("segment")
hp  = pd.read_csv(os.path.join(OUT,"hourly_profile.csv"), index_col=0)["rrp"]

# ---------- hourly profile ----------
fig, ax = plt.subplots(figsize=(8.0,3.45), dpi=170)
h=hp.index.values; v=hp.values
ax.fill_between(h,v,color="#D9D9D9",alpha=0.55,zorder=1)
ax.plot(h,v,color=DARK,lw=2.6,zorder=3)
ax.axvspan(9,14,color="#CFCFCF",alpha=0.45); ax.axvspan(16,21,color=ORANGE,alpha=0.12)
ax.scatter([12],[hp[12]],color=DARK,s=55,zorder=5); ax.scatter([18],[hp[18]],color=ORANGE,s=70,zorder=5)
ax.annotate(f"中午低谷 ${hp[12]:.0f}\n(12.4%时段为负价)",(12,hp[12]),xytext=(10.8,150),
            fontsize=9,color=DARK,ha="center",arrowprops=dict(arrowstyle="->",color=DARK))
ax.annotate(f"傍晚尖峰 ${hp[18]:.0f}",(18,hp[18]),xytext=(20.4,228),fontsize=9.5,color=ORANGE,
            ha="center",fontweight="bold",arrowprops=dict(arrowstyle="->",color=ORANGE))
ax.text(11.5,-30,"充电窗口",color=DARK,fontsize=8.5,ha="center")
ax.text(18.5,-30,"放电窗口",color=ORANGE,fontsize=8.5,ha="center",fontweight="bold")
ax.set_xlim(0,23); ax.set_ylim(-45,255); ax.set_xticks(range(0,24,2))
ax.set_xlabel("小时",fontsize=9); ax.set_ylabel("平均现货价 ($/MWh)",fontsize=9)
ax.axhline(0,color=MUTE,lw=0.8,ls="--")
for s in ["top","right"]: ax.spines[s].set_visible(False)
ax.tick_params(labelsize=8.5)
plt.tight_layout(); plt.savefig(os.path.join(CH,"hourly_profile.png")); plt.close()

# ---------- comparison ----------
def comp(seg,fname,ymax,upside):
    r=res.loc[seg]
    fig,ax=plt.subplots(figsize=(5.6,4.3),dpi=170)
    ax.bar(0,r.A_vpp_year,width=0.5,color=AGREY,label="零售套利",zorder=3)
    ax.bar(1,r.B_arb_year,width=0.5,color=ORANGE,label="批发套利",zorder=3)
    ax.bar(1,r.B_fcas_year,width=0.5,bottom=r.B_arb_year,color=ORANGE_L,label="FCAS",zorder=3)
    ax.text(0,r.A_vpp_year+ymax*0.015,f"${r.A_vpp_year:,.0f}",ha="center",fontsize=12,fontweight="bold",color=INK)
    ax.text(1,r.B_vpp_year+ymax*0.015,f"${r.B_vpp_year:,.0f}",ha="center",fontsize=13,fontweight="bold",color=ORANGE)
    ax.text(1,r.B_arb_year/2,f"批发套利\n${r.B_arb_year:,.0f}",ha="center",va="center",fontsize=9.5,color="white",fontweight="bold")
    ax.text(1,r.B_arb_year+r.B_fcas_year/2,f"FCAS ${r.B_fcas_year:,.0f}",ha="center",va="center",fontsize=8.5,color="white")
    ax.text(0,r.A_vpp_year/2,f"零售套利\n${r.A_vpp_year:,.0f}",ha="center",va="center",fontsize=9.5,color="white",fontweight="bold")
    # uplift badge
    ax.annotate(f"{r.uplift_x:.2f}×",xy=(0.5,ymax*0.9),fontsize=20,fontweight="bold",color=ORANGE,ha="center")
    # upside marker
    if upside:
        ax.hlines(r.B_vpp_year_2cyc,0.72,1.28,color=DARK,lw=1.3,ls=(0,(4,3)))
        ax.text(1.30,r.B_vpp_year_2cyc,f"2循环上行 ${r.B_vpp_year_2cyc:,.0f}",fontsize=8.5,color=DARK,va="center",ha="left")
    ax.set_xticks([0,1]); ax.set_xticklabels(["方案A\n零售套餐·无VPP","方案B\n批发套餐·VPP"],fontsize=10.5)
    ax.set_ylim(0,ymax); ax.set_ylabel("年VPP收益 (A$)",fontsize=9.5)
    ax.legend(fontsize=8.5,loc="upper left",frameon=False)
    ax.yaxis.grid(True,color=GRIDC,lw=0.7); ax.set_axisbelow(True)
    for s in ["top","right"]: ax.spines[s].set_visible(False)
    ax.tick_params(labelsize=8.5)
    plt.tight_layout(); plt.savefig(os.path.join(CH,fname)); plt.close()

comp("C&I","compare_ci.png", res.loc["C&I","B_vpp_year_2cyc"]*1.32, True)
comp("Residential","compare_resi.png", res.loc["Residential","B_vpp_year_2cyc"]*1.32, True)
print("charts:", sorted(os.listdir(CH)))
