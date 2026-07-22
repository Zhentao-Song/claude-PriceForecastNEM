# -*- coding: utf-8 -*-
"""Charts for StarCharge page-2 (投入回报分析). Orange palette."""
import numpy as np, os
import matplotlib; matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib import font_manager as fm

CH = "/sessions/funny-upbeat-darwin/mnt/claude-PriceForecastNEM/vpp_business_case/charts"
os.makedirs(CH, exist_ok=True)
fp="/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"
fm.fontManager.addfont(fp); plt.rcParams["font.family"]=fm.FontProperties(fname=fp).get_name()
plt.rcParams["axes.unicode_minus"]=False

ORANGE="#EC6A2C"; ORANGE_L="#F4A06A"; DARK="#3A3A3A"; GREY="#A9A9A9"; GRID="#ECECEC"; MUTE="#777"

# ---------- JV revenue growth trajectory ----------
labels=["2026 Q4","2027","2028 H1","2029+"]
x=np.arange(4)
resi=[65,100,130,324]
ci  =[92,160,230,459]
bess=[80,450,1000,2000]
total=[a+b+c for a,b,c in zip(resi,ci,bess)]

fig,ax=plt.subplots(figsize=(5.5,3.5),dpi=170)
ax.plot(x,bess,"-o",color=ORANGE,lw=3,ms=7,label="BESS运营",zorder=5)
ax.plot(x,ci,"-o",color=DARK,lw=2.4,ms=6,label="工商业VPP",zorder=4)
ax.plot(x,resi,"-o",color=GREY,lw=2.4,ms=6,label="民居VPP",zorder=3)
# total annotation
for i,t in enumerate(total):
    ax.annotate(f"合计{t:,}万",(x[i],bess[i]),textcoords="offset points",xytext=(0,11),
                ha="center",fontsize=8,color=ORANGE,fontweight="bold")
ax.set_xticks(x); ax.set_xticklabels(labels,fontsize=10)
ax.set_ylabel("运营商收入 (万 AUD/年)",fontsize=9.5)
ax.set_ylim(0,2300)
ax.yaxis.grid(True,color=GRID,lw=0.8); ax.set_axisbelow(True)
for s in ["top","right"]: ax.spines[s].set_visible(False)
ax.tick_params(labelsize=8.5)
ax.legend(fontsize=9,loc="upper left",frameon=False)
plt.tight_layout(); plt.savefig(f"{CH}/p2_growth.png"); plt.close()

# ---------- customer retention ----------
yr=["Year 1","Year 2","Year 3","Year 4+"]
xr=np.arange(4)
ci_r=[88,91,93,94]
re_r=[80,85,88,90]
ind =[78,81,83,85]
fig,ax=plt.subplots(figsize=(5.5,3.5),dpi=170)
ax.plot(xr,ci_r,"-o",color=DARK,lw=2.6,ms=6,label="工商业 C&I")
ax.plot(xr,re_r,"-o",color=ORANGE,lw=2.6,ms=6,label="居民户用")
ax.plot(xr,ind,"--o",color=GREY,lw=2,ms=5,label="行业均值")
ax.set_xticks(xr); ax.set_xticklabels(yr,fontsize=10)
ax.set_ylabel("客户留存率 (%)",fontsize=9.5); ax.set_ylim(74,98)
ax.yaxis.grid(True,color=GRID,lw=0.8); ax.set_axisbelow(True)
for s in ["top","right"]: ax.spines[s].set_visible(False)
ax.tick_params(labelsize=8.5)
ax.legend(fontsize=9,loc="lower right",frameon=False)
for i in range(4):
    ax.annotate(f"{ci_r[i]}",(xr[i],ci_r[i]),textcoords="offset points",xytext=(0,8),ha="center",fontsize=7.5,color=DARK)
plt.tight_layout(); plt.savefig(f"{CH}/p2_retention.png"); plt.close()

# ---------- colorful floral bottom band ----------
rng=np.random.default_rng(7)
fig,ax=plt.subplots(figsize=(13.3,0.42),dpi=170)
cols=["#EC6A2C","#F4B23C","#E8453C","#3FA98A","#3E78B2","#9C5BB0","#E86AA6","#6FBF44","#F2D02E"]
n=170
for i in range(n):
    cx=i*(13.3/n)+rng.uniform(-0.02,0.02); cy=rng.uniform(0.25,0.75)
    c=cols[rng.integers(len(cols))]
    # 4-petal flower
    for ang in range(0,360,90):
        dx=0.022*np.cos(np.radians(ang)); dy=0.13*np.sin(np.radians(ang))
        ax.scatter(cx+dx,cy+dy,s=11,color=c,marker="o",edgecolors="none")
    ax.scatter(cx,cy,s=7,color="#FFE9B0",marker="o",edgecolors="none")
ax.set_xlim(0,13.3); ax.set_ylim(0,1); ax.axis("off")
plt.subplots_adjust(left=0,right=1,top=1,bottom=0)
plt.savefig(f"{CH}/p2_floral.png",transparent=True); plt.close()

# ---------- StarCharge-style star logo ----------
fig,ax=plt.subplots(figsize=(1.1,1.1),dpi=200)
import matplotlib.patches as mp
# 8-point starburst
N=8; rO=1.0; rI=0.42
pts=[]
for i in range(2*N):
    r=rO if i%2==0 else rI
    a=np.pi/2 + i*np.pi/N
    pts.append((r*np.cos(a), r*np.sin(a)))
ax.add_patch(mp.Polygon(pts, closed=True, facecolor="#EC2D27", edgecolor="none"))
# inner small star (white)
pts2=[(0.5*x,0.5*y) for x,y in pts]
ax.add_patch(mp.Polygon(pts2, closed=True, facecolor="#F4922E", edgecolor="none"))
ax.scatter(0,0,s=90,color="white",zorder=5)
ax.set_xlim(-1.1,1.1); ax.set_ylim(-1.1,1.1); ax.set_aspect("equal"); ax.axis("off")
plt.subplots_adjust(left=0,right=1,top=1,bottom=0)
plt.savefig(f"{CH}/p2_logo.png",transparent=True); plt.close()

print("p2 charts:", [f for f in os.listdir(CH) if f.startswith("p2_")])
