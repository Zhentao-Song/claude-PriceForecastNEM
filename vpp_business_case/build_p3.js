const pptx=require("pptxgenjs");
const CH=__dirname+"/charts";
const ORANGE="EC6A2C", BRIGHT="F0531F", TINT="FCEEE3", GREY="F3F3F3",
      INK="2E2E2E", MUTE="6E6E6E", LINE="E2E2E2", WHITE="FFFFFF";
const F="PingFang SC";
let p=new pptx(); p.defineLayout({name:"W",width:13.333,height:7.5}); p.layout="W";
const W=13.333,H=7.5;
let s=p.addSlide(); s.background={color:WHITE};

/* header */
s.addShape(p.shapes.RECTANGLE,{x:0.45,y:0.4,w:0.5,h:0.07,fill:{color:ORANGE}});
s.addText("运营推广",{x:1.0,y:0.16,w:5,h:0.6,fontSize:26,bold:true,color:INK,fontFace:F,valign:"middle"});
s.addText("@宋震涛",{x:3.05,y:0.25,w:3,h:0.45,fontSize:14,color:MUTE,fontFace:F,valign:"middle"});
s.addImage({path:CH+"/p2_logo.png",x:10.85,y:0.16,w:0.6,h:0.6});
s.addText([{text:"StarCharge",options:{bold:true,color:INK,breakLine:true}},{text:"星星充电",options:{color:ORANGE,bold:true}}],
  {x:11.5,y:0.14,w:1.8,h:0.66,fontSize:12.5,fontFace:F,valign:"middle",align:"left",lineSpacingMultiple:1.0,margin:0});

function secNum(x,y,n){
  s.addShape(p.shapes.RECTANGLE,{x,y,w:0.34,h:0.34,fill:{color:ORANGE}});
  s.addText(n,{x,y,w:0.34,h:0.34,fontSize:15,bold:true,color:WHITE,align:"center",valign:"middle",fontFace:F,margin:0});
}

/* ===== LEFT: 试点运营计划 ===== */
let lx=0.45, lw=4.75;
secNum(lx,1.05,"1");
s.addText("试点运营计划",{x:lx+0.45,y:1.03,w:lw-0.45,h:0.4,fontSize:16,bold:true,color:INK,fontFace:F,valign:"middle",margin:0});
const chans=[
 ["Solar Juice 增量客户","工商业 1–2MW/月、户用 1MW/月；成交即捆绑VPP注册，安装商返佣"],
 ["中集储能","存量 + 增量工商业用户；存量基数可快速入池"],
 ["SolarJuice + GoldWind","<5MW 网侧储能项目 8 个（≈40MW），BESS兜底代运营"],
 ["GCGF（平台授权客户）","自有资产接入我方VPP平台，按其收益约15%抽成"],
];
let cy=1.62;
chans.forEach(c=>{
  s.addShape(p.shapes.RECTANGLE,{x:lx,y:cy,w:lw,h:0.92,fill:{color:GREY}});
  s.addShape(p.shapes.RECTANGLE,{x:lx,y:cy,w:0.08,h:0.92,fill:{color:ORANGE}});
  s.addText(c[0],{x:lx+0.2,y:cy+0.08,w:lw-0.35,h:0.3,fontSize:11.5,bold:true,color:INK,fontFace:F,margin:0,valign:"middle"});
  s.addText(c[1],{x:lx+0.2,y:cy+0.36,w:lw-0.35,h:0.52,fontSize:10,color:MUTE,fontFace:F,margin:0,valign:"top",lineSpacingMultiple:1.04});
  cy+=1.02;
});
// 50MW chip
s.addShape(p.shapes.RECTANGLE,{x:lx,y:cy+0.02,w:lw,h:0.6,fill:{color:TINT}});
s.addShape(p.shapes.RECTANGLE,{x:lx,y:cy+0.02,w:0.08,h:0.6,fill:{color:ORANGE}});
s.addText([{text:"首批合计 ≈ 50MW",options:{bold:true,color:BRIGHT}},{text:"   户用 / 工商 / 网侧BESS",options:{color:MUTE,fontSize:10}}],
  {x:lx+0.2,y:cy+0.02,w:lw-0.3,h:0.6,fontSize:13,fontFace:F,valign:"middle",margin:0});

/* ===== RIGHT: 运营推广计划 ===== */
let rx=5.55, rw=7.33;
secNum(rx,1.05,"2");
s.addText("运营推广计划",{x:rx+0.45,y:1.03,w:rw-0.45,h:0.4,fontSize:16,bold:true,color:INK,fontFace:F,valign:"middle",margin:0});

function block(y,h,label,rich){
  s.addShape(p.shapes.RECTANGLE,{x:rx,y,w:rw,h,fill:{color:GREY}});
  s.addShape(p.shapes.RECTANGLE,{x:rx,y,w:0.08,h,fill:{color:ORANGE}});
  s.addText(label,{x:rx+0.2,y:y+0.07,w:rw-0.4,h:0.28,fontSize:12,bold:true,color:ORANGE,fontFace:F,margin:0,valign:"middle"});
  s.addText(rich,{x:rx+0.2,y:y+0.36,w:rw-0.4,h:h-0.42,fontSize:10.3,color:INK,fontFace:F,margin:0,valign:"top",lineSpacingMultiple:1.06});
}
block(1.62,0.86,"① 核心定位：自有 VPP 平台 = 护城河",
  [{text:"平台（资产接入 + 现货/FCAS交易调度 + 结算）是抽30%/15%的依据——卖的不是装机，是把 NEM 波动变现的能力。",options:{color:MUTE}}]);
block(2.56,1.04,"② 双产品线放量",
  [{text:"自营 VPP（抽30%）：",options:{bold:true}},{text:"渠道捆绑获客，C&I优先、户用走量、网侧BESS压舱。",options:{color:MUTE,breakLine:true}},
   {text:"平台授权（抽~15%）：",options:{bold:true}},{text:"白标输出给“有资产、没能力”的业主/基金，GCGF打样后批量复制，轻资产放量快。",options:{color:MUTE}}]);
block(3.72,1.30,"③ 推广打法",
  [{text:"渠道默认捆绑：",options:{bold:true}},{text:"购电池即注册VPP（opt-out）+ 安装商阶梯返佣。",options:{color:MUTE,breakLine:true}},
   {text:"差异化价值主张：",options:{bold:true}},{text:"户用“零成本多赚+保底”｜工商“储能变利润中心+需量协同”｜BESS“代运营兜底，IRR 22%>15%”。",options:{color:MUTE,breakLine:true}},
   {text:"标杆先行：",options:{bold:true}},{text:"每渠道先做1–2个可复制样板 + 透明收益看板。",options:{color:MUTE}}]);
block(5.14,1.12,"④ 运营后台 + 持牌路径",
  [{text:"接入标准化",options:{bold:true}},{text:"（设备白名单/遥测/计量）→ ",options:{color:MUTE}},
   {text:"现货+FCAS联合优化交易+风控",options:{bold:true}},{text:" → ",options:{color:MUTE}},
   {text:"月度透明结算+兜底",options:{bold:true}},{text:" → App留存。",options:{color:MUTE,breakLine:true}},
   {text:"持牌：",options:{bold:true}},{text:"近期挂靠市场主体 → 中期自建DRSP → 远期 IRP 独立持牌。",options:{color:MUTE}}]);

/* KPI strip */
s.addShape(p.shapes.RECTANGLE,{x:0.45,y:6.42,w:W-0.9,h:0.5,fill:{color:ORANGE}});
s.addText([{text:"KPI　",options:{bold:true,color:WHITE}},
  {text:"月入池MW　｜　注册转化率　｜　实际 $/kW vs 模型　｜　留存率　｜　FCAS利用率",options:{color:"FFF0E8"}}],
  {x:0.7,y:6.42,w:W-1.3,h:0.5,fontSize:11.5,fontFace:F,valign:"middle",margin:0});

/* floral band */
s.addImage({path:CH+"/p2_floral.png",x:0,y:7.0,w:W,h:0.42});

p.writeFile({fileName:__dirname+"/星星充电_运营推广.pptx"}).then(f=>console.log("WROTE",f));
