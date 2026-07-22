const pptx = require("pptxgenjs");
const CH = __dirname + "/charts";

const WHITE="FFFFFF", GREY="F5F5F5", ORANGE="FE4400", INK="222222",
      MUTE="6B6B6B", LINE="E2E2E2", TINT="FFF0EB", AGREY="9A9A9A", DARK="3A3A3A";
const F="PingFang SC";
let p = new pptx();
p.defineLayout({ name:"W", width:13.333, height:7.5 }); p.layout="W";
const W=13.333, H=7.5;
const sh = () => ({ type:"outer", color:"000000", blur:6, offset:2, angle:135, opacity:0.10 });

function footer(s){
  s.addShape(p.shapes.LINE,{x:0.45,y:H-0.5,w:W-0.9,h:0,line:{color:LINE,width:1}});
  s.addText("数据来源：AEMO DISPATCHPRICE 真实5分钟数据 (NSW1, 2025 Q1, 25,632区间, 含RRP+8个FCAS服务价)  ·  仅含VPP收益(套利+FCAS)  ·  运营商分成30%  ·  保守口径(季节0.80×预见性0.85×单循环)",
    {x:0.45,y:H-0.45,w:12.4,h:0.32,fontSize:7.6,color:AGREY,fontFace:F,align:"left",valign:"middle"});
}
function chip(s,x,y,w,big,bigCol,label){
  s.addShape(p.shapes.RECTANGLE,{x,y,w,h:0.92,fill:{color:GREY}});
  s.addShape(p.shapes.RECTANGLE,{x,y,w:0.09,h:0.92,fill:{color:ORANGE}});
  s.addText(big,{x:x+0.22,y:y+0.1,w:w-0.35,h:0.5,fontSize:25,bold:true,color:bigCol,fontFace:F,align:"left",valign:"middle",margin:0});
  s.addText(label,{x:x+0.22,y:y+0.58,w:w-0.35,h:0.3,fontSize:10.5,color:MUTE,fontFace:F,align:"left",valign:"middle",margin:0});
}
function card(s,x,y,w,h,fill){ s.addShape(p.shapes.RECTANGLE,{x,y,w,h,fill:{color:fill||GREY},shadow:sh()}); }
function cardTitle(s,x,y,txt,col){
  s.addShape(p.shapes.RECTANGLE,{x,y:y+0.04,w:0.09,h:0.28,fill:{color:col||ORANGE}});
  s.addText(txt,{x:x+0.2,y,w:6,h:0.36,fontSize:14,bold:true,color:INK,fontFace:F,margin:0,valign:"middle"});
}

/* tables reused */
function dealTable(s,x,y,w,rows){
  return s.addTable(rows,{x,y,w,fontSize:11,color:INK,fontFace:F,
    border:{pt:0.5,color:LINE},align:"center",valign:"middle",rowH:Array(rows.length).fill(0.288)});
}

/* ================= SLIDE 1 — C&I ================= */
let s=p.addSlide(); s.background={color:WHITE};
s.addText([{text:"场景一  ",options:{color:INK}},{text:"工商业 C&I",options:{color:ORANGE}}],
  {x:0.45,y:0.3,w:8,h:0.7,fontSize:30,bold:true,fontFace:F});
s.addShape(p.shapes.RECTANGLE,{x:9.0,y:0.42,w:3.88,h:0.5,fill:{color:ORANGE}});
s.addText("结论：值得大力投入",{x:9.0,y:0.42,w:3.88,h:0.5,fontSize:14.5,bold:true,color:WHITE,fontFace:F,align:"center",valign:"middle"});

// hero chips
chip(s,0.45,1.12,4.0,"1.85×","FE4400","VPP收益提升（单站·年）");
chip(s,4.65,1.12,4.0,"$15,290","222222","方案B 单站VPP收益/年");
chip(s,8.85,1.12,4.03,"$459k","FE4400","运营商收益/100站·年 (30%)");

// chart
s.addImage({path:CH+"/compare_ci.png",x:0.35,y:2.2,w:6.35,h:4.78});

// right column
let rx=6.95, rw=5.9;
// config card
card(s,rx,2.2,rw,1.5,GREY);
cardTitle(s,rx+0.2,2.30,"基础数据（典型工商业站点）");
s.addText([
  {text:"年用电  ",options:{color:MUTE}},{text:"300 MWh",options:{bold:true,breakLine:true}},
  {text:"光伏  ",options:{color:MUTE}},{text:"100 kW",options:{bold:true,breakLine:true}},
  {text:"储能  ",options:{color:MUTE}},{text:"215 kWh / 100 kW",options:{bold:true}},
],{x:rx+0.22,y:2.70,w:2.85,h:0.78,fontSize:11,color:INK,fontFace:F,lineSpacingMultiple:1.1,valign:"top"});
s.addText([
  {text:"套餐  ",options:{color:MUTE}},{text:"批发市场",options:{bold:true,color:ORANGE,breakLine:true}},
  {text:"套利时段  ",options:{color:MUTE}},{text:"非工作时段*",options:{bold:true,breakLine:true}},
  {text:"往返效率  ",options:{color:MUTE}},{text:"90%",options:{bold:true}},
],{x:rx+3.05,y:2.70,w:2.7,h:0.78,fontSize:11,color:INK,fontFace:F,lineSpacingMultiple:1.1,valign:"top"});
s.addText("* 工作日 08–17 点电池优先服务负荷，套利仅在非工作时段，已错失中午负价仍近翻倍",
  {x:rx+0.22,y:3.40,w:rw-0.4,h:0.26,fontSize:8.4,italic:true,color:AGREY,fontFace:F});

// breakdown table
card(s,rx,3.78,rw,1.92,WHITE);
cardTitle(s,rx+0.2,3.86,"收益拆解（单站·年，A$）");
dealTable(s,rx+0.2,4.24,rw-0.4,[
  [{text:"项目",options:{bold:true,color:WHITE,fill:{color:INK}}},{text:"方案A 零售",options:{bold:true,color:WHITE,fill:{color:INK}}},{text:"方案B VPP",options:{bold:true,color:WHITE,fill:{color:ORANGE}}}],
  ["套利","$8,283","$11,480"],
  ["FCAS","—","$3,810"],
  [{text:"VPP收益合计",options:{bold:true,fill:{color:GREY}}},{text:"$8,283",options:{bold:true,fill:{color:GREY}}},{text:"$15,290",options:{bold:true,color:ORANGE,fill:{color:GREY}}}],
  [{text:"运营商30%分成",options:{bold:true}},"$2,485",{text:"$4,587",options:{bold:true,color:ORANGE}}],
]);

// insight card (orange tint)
card(s,rx,5.78,rw,1.18,TINT);
cardTitle(s,rx+0.2,5.86,"为什么值得大干",ORANGE);
s.addText([
  {text:"① 近翻倍且抗约束：",options:{bold:true,color:ORANGE}},{text:"即便白天服务负荷、错失中午负价，方案B仍达1.85×。  ",options:{}},
  {text:"② 单站经济性强：",options:{bold:true,color:ORANGE}},{text:"运营商$4,587/站，2循环上行$17,791(分成$5,337)。  ",options:{}},
  {text:"③ 规模杠杆：",options:{bold:true,color:ORANGE}},{text:"100站即贡献运营商$459k/年(增量$210k)。",options:{}},
],{x:rx+0.22,y:6.22,w:rw-0.4,h:0.7,fontSize:10.2,color:INK,fontFace:F,lineSpacingMultiple:1.05,valign:"top"});
footer(s);

/* ================= SLIDE 2 — Residential ================= */
s=p.addSlide(); s.background={color:WHITE};
s.addText([{text:"场景二  ",options:{color:INK}},{text:"户用 Residential",options:{color:AGREY}}],
  {x:0.45,y:0.3,w:8,h:0.7,fontSize:30,bold:true,fontFace:F});
s.addShape(p.shapes.RECTANGLE,{x:8.5,y:0.42,w:4.38,h:0.5,fill:{color:GREY},line:{color:AGREY,width:1}});
s.addText("结论：铺量为主，非收益主引擎",{x:8.5,y:0.42,w:4.38,h:0.5,fontSize:13.5,bold:true,color:MUTE,fontFace:F,align:"center",valign:"middle"});

chip(s,0.45,1.12,4.0,"1.16×","222222","VPP提升（基准，2循环1.48×）");
chip(s,4.65,1.12,4.0,"$1,083","222222","方案B 单户VPP收益/年");
chip(s,8.85,1.12,4.03,"$325","6B6B6B","运营商收益/户·年 (30%)");

s.addImage({path:CH+"/compare_resi.png",x:0.35,y:2.2,w:6.35,h:4.78});

// config
card(s,rx,2.2,rw,1.5,GREY);
cardTitle(s,rx+0.2,2.30,"基础数据（典型户用）",AGREY);
s.addText([
  {text:"年用电  ",options:{color:MUTE}},{text:"5,500 kWh",options:{bold:true,breakLine:true}},
  {text:"光伏  ",options:{color:MUTE}},{text:"6.6 kW",options:{bold:true,breakLine:true}},
  {text:"储能  ",options:{color:MUTE}},{text:"13.5 kWh / 5 kW",options:{bold:true}},
],{x:rx+0.22,y:2.70,w:2.85,h:0.78,fontSize:11,color:INK,fontFace:F,lineSpacingMultiple:1.1,valign:"top"});
s.addText([
  {text:"套餐  ",options:{color:MUTE}},{text:"批发市场",options:{bold:true,breakLine:true}},
  {text:"套利时段  ",options:{color:MUTE}},{text:"全天可用",options:{bold:true,breakLine:true}},
  {text:"往返效率  ",options:{color:MUTE}},{text:"90%",options:{bold:true}},
],{x:rx+3.05,y:2.70,w:2.7,h:0.78,fontSize:11,color:INK,fontFace:F,lineSpacingMultiple:1.1,valign:"top"});
s.addText("户用无工作/非工作之分，电池全天可套利，但5kW功率+单循环限制了价差捕获能力",
  {x:rx+0.22,y:3.40,w:rw-0.4,h:0.26,fontSize:8.4,italic:true,color:AGREY,fontFace:F});

card(s,rx,3.78,rw,1.92,WHITE);
cardTitle(s,rx+0.2,3.86,"收益拆解（单户·年，A$）",AGREY);
dealTable(s,rx+0.2,4.24,rw-0.4,[
  [{text:"项目",options:{bold:true,color:WHITE,fill:{color:INK}}},{text:"方案A 零售",options:{bold:true,color:WHITE,fill:{color:INK}}},{text:"方案B VPP",options:{bold:true,color:WHITE,fill:{color:AGREY}}}],
  ["套利","$931","$904"],
  ["FCAS","—","$179"],
  [{text:"VPP收益合计",options:{bold:true,fill:{color:GREY}}},{text:"$931",options:{bold:true,fill:{color:GREY}}},{text:"$1,083",options:{bold:true,fill:{color:GREY}}}],
  [{text:"运营商30%分成",options:{bold:true}},"$279","$325"],
]);

card(s,rx,5.78,rw,1.18,GREY);
cardTitle(s,rx+0.2,5.86,"为什么不宜重押",AGREY);
s.addText([
  {text:"① 裸套利无优势：",options:{bold:true}},{text:"5kW+单循环下批发套利($904)≈优质零售价差($931)。  ",options:{}},
  {text:"② 增量薄：",options:{bold:true}},{text:"提升主要靠FCAS($179)与多循环，单户分成仅$325。  ",options:{}},
  {text:"③ ",options:{bold:true}},{text:"约",options:{}},{text:"14户",options:{bold:true,color:ORANGE}},{text:" 才抵 ",options:{}},{text:"1个工商业站",options:{bold:true,color:ORANGE}},{text:" 的运营商收益 → 价值在户数规模与聚合容量。",options:{}},
],{x:rx+0.22,y:6.22,w:rw-0.4,h:0.7,fontSize:10.2,color:INK,fontFace:F,lineSpacingMultiple:1.05,valign:"top"});
footer(s);

/* ================= SLIDE 3 — Methodology + arb source ================= */
s=p.addSlide(); s.background={color:WHITE};
s.addText("方法论、数据来源与套利价值的来源",{x:0.45,y:0.3,w:12,h:0.7,fontSize:27,bold:true,color:INK,fontFace:F});

// LEFT column
let lx=0.45, lw=6.05;
card(s,lx,1.2,lw,2.28,GREY);
cardTitle(s,lx+0.2,1.30,"测算逻辑");
s.addText([
  {text:"电池调度模型：",options:{bold:true,breakLine:true}},
  {text:"给定真实价格序列+电池约束(容量/功率/效率/循环)，逐日求最优低充高放套利，叠加FCAS容量收益。\n",options:{color:MUTE,breakLine:true}},
  {text:"方案A 基线：",options:{bold:true,color:AGREY}},{text:"零售TOU套餐、无VPP，只赚零售峰谷价差。\n",options:{color:MUTE,breakLine:true}},
  {text:"方案B VPP：",options:{bold:true,color:ORANGE}},{text:"批发套餐，赚现货套利+(工商业)非工作时段套利+FCAS八市场。",options:{color:MUTE}},
],{x:lx+0.22,y:1.70,w:lw-0.44,h:1.7,fontSize:11,color:INK,fontFace:F,lineSpacingMultiple:1.1,valign:"top"});

card(s,lx,3.60,lw,1.86,WHITE);
cardTitle(s,lx+0.2,3.70,"数据来源（真实，可追溯）");
s.addText([
  {text:"• AEMO DISPATCHPRICE 表，NSW1，2025-01-01 → 03-31\n",options:{breakLine:true}},
  {text:"• 25,632 个5分钟区间，含 RRP + 8个FCAS服务价格\n",options:{breakLine:true}},
  {text:"• 区间均价 $88/MWh，与AEMO季报水平一致\n",options:{breakLine:true}},
  {text:"• 零售TOU、PV/储能配置取行业公开基准",options:{}},
],{x:lx+0.22,y:4.08,w:lw-0.44,h:1.3,fontSize:10.4,color:INK,fontFace:F,lineSpacingMultiple:1.18,valign:"top"});

card(s,lx,5.56,lw,1.42,TINT);
cardTitle(s,lx+0.2,5.64,"保守口径（避免高估）",ORANGE);
s.addText([
  {text:"季节折减 0.80",options:{bold:true}},{text:"(夏季Q1→全年) × ",options:{color:MUTE}},
  {text:"预见性折减 0.85",options:{bold:true}},{text:"(无法完美捕获尖峰) × ",options:{color:MUTE}},
  {text:"基准单循环/天",options:{bold:true}},{text:"。FCAS价已反映2025大幅压缩后水平。",options:{color:MUTE}},
],{x:lx+0.22,y:6.04,w:lw-0.44,h:0.88,fontSize:10.4,color:INK,fontFace:F,lineSpacingMultiple:1.1,valign:"top"});

// RIGHT column — arbitrage source
let ax=6.75, aw=6.1;
cardTitle(s,ax,1.28,"套利价值的来源：NSW现货日内曲线");
s.addImage({path:CH+"/hourly_profile.png",x:ax-0.05,y:1.66,w:6.15,h:2.65});
s.addText("中午光伏将现货压至~$20/MWh甚至负价，傍晚17–18点冲到~$212/MWh——巨大的日内价差是VPP批发套利(方案B)的核心来源。",
  {x:ax,y:4.32,w:aw,h:0.6,fontSize:10.6,color:MUTE,fontFace:F,lineSpacingMultiple:1.12});

const facts=[["$623/MWh","日内套利价差均值(峰谷)"],["12.4%","时段现货为负价"],["8 市场","可叠加的FCAS服务"],["$7.6/MW·h","调频Raise均价(已压缩)"]];
let fx=ax, fy=5.05, fw=(aw-0.2)/2, fh=0.9;
facts.forEach((f,i)=>{
  const x=fx+(i%2)*(fw+0.2), y=fy+Math.floor(i/2)*(fh+0.18);
  s.addShape(p.shapes.RECTANGLE,{x,y,w:fw,h:fh,fill:{color:GREY}});
  s.addShape(p.shapes.RECTANGLE,{x,y,w:0.09,h:fh,fill:{color:ORANGE}});
  s.addText(f[0],{x:x+0.2,y:y+0.1,w:fw-0.3,h:0.45,fontSize:19,bold:true,color:ORANGE,fontFace:F,margin:0,valign:"middle"});
  s.addText(f[1],{x:x+0.2,y:y+0.55,w:fw-0.3,h:0.3,fontSize:10,color:MUTE,fontFace:F,margin:0,valign:"middle"});
});
footer(s);

p.writeFile({ fileName: __dirname + "/VPP立项测算_工商业vs户用.pptx" }).then(f=>console.log("WROTE",f));
