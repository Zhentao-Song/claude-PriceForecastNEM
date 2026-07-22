const pptx=require("pptxgenjs");
const CH=__dirname+"/charts";
const ORANGE="EC6A2C", BRIGHT="F0531F", TINT="FCEEE3", GREY="F3F3F3",
      INK="2E2E2E", MUTE="6E6E6E", LINE="E2E2E2", WHITE="FFFFFF";
const F="PingFang SC";
let p=new pptx(); p.defineLayout({name:"W",width:13.333,height:7.5}); p.layout="W";
const W=13.333,H=7.5;
let s=p.addSlide(); s.background={color:WHITE};

/* header */
s.addShape(p.shapes.RECTANGLE,{x:0.45,y:0.34,w:0.5,h:0.07,fill:{color:ORANGE}});
s.addText("资产运营量放量策略",{x:1.0,y:0.1,w:8,h:0.56,fontSize:24,bold:true,color:INK,fontFace:F,valign:"middle"});
s.addText("两类资产 × 存量/增量  ·  以 <5MW BESS 为主轴，C&I 做基本盘",{x:1.0,y:0.64,w:9,h:0.3,fontSize:11.5,color:MUTE,fontFace:F,valign:"middle"});
s.addImage({path:CH+"/p2_logo.png",x:10.85,y:0.1,w:0.56,h:0.56});
s.addText([{text:"StarCharge",options:{bold:true,color:INK,breakLine:true}},{text:"星星充电",options:{color:ORANGE,bold:true}}],
  {x:11.5,y:0.08,w:1.8,h:0.62,fontSize:12,fontFace:F,valign:"middle",align:"left",lineSpacingMultiple:1.0,margin:0});
s.addImage({path:CH+"/p2_floral.png",x:0,y:7.0,w:W,h:0.42});

function subhead(x,y,txt,w){
  s.addShape(p.shapes.RECTANGLE,{x,y:y+0.02,w:0.08,h:0.26,fill:{color:ORANGE}});
  s.addText(txt,{x:x+0.18,y,w:(w||6),h:0.32,fontSize:13.5,bold:true,color:INK,fontFace:F,margin:0,valign:"middle"});
}

/* ===== 2x2 asset matrix ===== */
subhead(0.45,1.0,"资产盘：两类资产 × 两个来源");
const HC={fill:{color:INK},color:WHITE,bold:true};
const LC={fill:{color:"4A4A4A"},color:WHITE,bold:true};
const star=t=>({text:t,options:{fill:{color:TINT}}});
const grid=[
 [{text:"资产 ＼ 来源",options:HC},{text:"存量（已通电 · 最快）",options:HC},{text:"增量（在建/在售 · 要锁定）",options:HC}],
 [{text:"工商业\nBTM 储能",options:LC},
  "中集存量 + 已装只自用的 C&I 电池\nOTA 入池，卖点：零成本多赚 + 保底",
  "中集 / SolarJuice / EPC 新单\n销售即默认捆绑入池（安装商激励）"],
 [{text:"<5MW BESS\n网侧/独立/社区",options:LC},
  "独立电池优化不足 + DNSP 社区电池\n给“优化代运营 / tolling”，分增量收益",
  star("开发管道（GoldWind 8 个…）\n开发期签 MOU，COD 自动入池  ★MW最快")],
];
s.addTable(grid,{x:0.45,y:1.42,w:8.35,colW:[1.75,3.3,3.3],rowH:[0.46,1.05,1.05],
 fontSize:9.6,fontFace:F,color:INK,align:"center",valign:"middle",
 border:{type:"solid",pt:0.5,color:LINE}});

/* BESS callout */
let qx=9.0, qw=3.88;
s.addShape(p.shapes.RECTANGLE,{x:qx,y:1.42,w:qw,h:2.56,fill:{color:TINT}});
s.addShape(p.shapes.RECTANGLE,{x:qx,y:1.42,w:0.1,h:2.56,fill:{color:ORANGE}});
s.addText("<5MW BESS = 放量主力",{x:qx+0.22,y:1.54,w:qw-0.4,h:0.34,fontSize:14,bold:true,color:BRIGHT,fontFace:F,margin:0});
s.addText([
 {text:"40,000 AUD/MW·年",options:{bold:true}},{text:"，兜底全归你\n",options:{color:MUTE,breakLine:true}},
 {text:"250MW ≈ $1,000 万/年\n",options:{bold:true,breakLine:true}},
 {text:"单笔 MW 大、单位收益最高\n",options:{color:INK,breakLine:true}},
 {text:"→ 以 BESS 为主轴放量，\nC&I 做稳定基本盘",options:{bold:true,color:ORANGE}},
],{x:qx+0.22,y:1.96,w:qw-0.42,h:1.9,fontSize:11.5,color:INK,fontFace:F,margin:0,valign:"top",lineSpacingMultiple:1.3});

/* ===== 放量路径 ===== */
subhead(0.45,4.18,"快速放量路径：从“一户户签”到“框架带量”");
const paths=[["框架 / MOU 带量","一签带一组合MW"],["管道锁定","BESS开发期MOU"],
 ["平台授权（15%）","轻资产·搬上你平台"],["标杆复制","试点$/kW做证据"],["买量","收购聚合商/book"]];
let px=0.45, pw=2.435, pg=0.062;
paths.forEach((c,i)=>{
 const x=px+i*(pw+pg);
 s.addShape(p.shapes.RECTANGLE,{x,y:4.58,w:pw,h:0.74,fill:{color:GREY}});
 s.addShape(p.shapes.RECTANGLE,{x,y:4.58,w:0.07,h:0.74,fill:{color:ORANGE}});
 s.addText(c[0],{x:x+0.16,y:4.64,w:pw-0.24,h:0.32,fontSize:11,bold:true,color:INK,fontFace:F,margin:0,valign:"middle"});
 s.addText(c[1],{x:x+0.16,y:4.96,w:pw-0.24,h:0.3,fontSize:9,color:MUTE,fontFace:F,margin:0,valign:"middle"});
});

/* ===== 出MW优先级 ===== */
subhead(0.45,5.5,"出 MW 优先级（按速度排）");
const pri=[["1","<5MW BESS存量 + 中集C&I存量","签约即入池 · 最快"],
 ["2","<5MW BESS增量 · 管道锁定","单笔大 · 提前锁"],
 ["3","平台授权","轻资产 · 批量带入"],
 ["4","C&I增量 · 渠道默认捆绑","稳定流"]];
let ax=0.45, aw=3.0, ag=0.143;
pri.forEach((c,i)=>{
 const x=ax+i*(aw+ag);
 s.addShape(p.shapes.RECTANGLE,{x,y:5.9,w:aw,h:0.86,fill:{color:i===0?TINT:GREY}});
 s.addShape(p.shapes.OVAL,{x:x+0.14,y:6.04,w:0.4,h:0.4,fill:{color:ORANGE}});
 s.addText(c[0],{x:x+0.14,y:6.04,w:0.4,h:0.4,fontSize:16,bold:true,color:WHITE,align:"center",valign:"middle",fontFace:F,margin:0});
 s.addText(c[1],{x:x+0.64,y:5.98,w:aw-0.74,h:0.42,fontSize:10.3,bold:true,color:INK,fontFace:F,margin:0,valign:"middle"});
 s.addText(c[2],{x:x+0.64,y:6.38,w:aw-0.74,h:0.3,fontSize:9,color:MUTE,fontFace:F,margin:0,valign:"middle"});
});

/* KPI strip is omitted to keep room; add a slim note */
s.addText([{text:"KPI：",options:{bold:true,color:BRIGHT}},
 {text:"在管 MW ｜ 管道 MW（已签未 COD）｜ 存量转化率 ｜ 实际 $/kW vs 模型",options:{color:MUTE}}],
 {x:0.45,y:6.84,w:12.4,h:0.16,fontSize:9.2,fontFace:F,margin:0,valign:"middle"});

p.writeFile({fileName:__dirname+"/星星充电_资产放量策略.pptx"}).then(f=>console.log("WROTE",f));
