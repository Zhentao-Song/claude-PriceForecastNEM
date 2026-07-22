const pptx=require("pptxgenjs");
const CH=__dirname+"/charts";
const ORANGE="EC6A2C", BRIGHT="F0531F", TINT="FCEEE3", GREY="F3F3F3",
      INK="2E2E2E", MUTE="7A7A7A", LINE="E2E2E2", WHITE="FFFFFF", DARK="3A3A3A";
const F="PingFang SC";
let p=new pptx(); p.defineLayout({name:"W",width:13.333,height:7.5}); p.layout="W";
const W=13.333,H=7.5;
let s=p.addSlide(); s.background={color:WHITE};

/* header */
s.addShape(p.shapes.RECTANGLE,{x:0.45,y:0.42,w:0.5,h:0.07,fill:{color:ORANGE}});
s.addText("投入回报分析",{x:1.0,y:0.18,w:7,h:0.6,fontSize:26,bold:true,color:INK,fontFace:F,valign:"middle"});
s.addText("@宋震涛",{x:3.95,y:0.27,w:3,h:0.45,fontSize:14,color:MUTE,fontFace:F,valign:"middle"});
// logo
s.addImage({path:CH+"/p2_logo.png",x:10.85,y:0.18,w:0.6,h:0.6});
s.addText([{text:"StarCharge",options:{bold:true,color:INK,breakLine:true}},{text:"星星充电",options:{color:ORANGE,bold:true}}],
  {x:11.5,y:0.16,w:1.8,h:0.66,fontSize:12.5,fontFace:F,valign:"middle",align:"left",lineSpacingMultiple:1.0,margin:0});

/* milestone cards */
const cards=[
  ["237万","AUD/年","首批规模","50MW · 试点阶段",true],
  ["~1,360万","AUD/年","中期规模","320MW · 2027–2028",false],
  ["~2,780万+","AUD/年","远期规模","650MW · IRP独立持牌",false],
];
let cx=0.45, cy=1.02, cw=4.06, cgap=0.18, chh=1.34;
cards.forEach((c,i)=>{
  const x=cx+i*(cw+cgap);
  s.addShape(p.shapes.RECTANGLE,{x,y:cy,w:cw,h:chh,fill:{color:c[4]?TINT:GREY}});
  s.addShape(p.shapes.RECTANGLE,{x,y:cy,w:0.1,h:chh,fill:{color:c[4]?ORANGE:"C9C9C9"}});
  s.addText(c[2],{x:x+0.28,y:cy+0.14,w:cw-0.5,h:0.3,fontSize:12,bold:true,color:MUTE,fontFace:F,margin:0});
  s.addText([{text:c[0],options:{bold:true,color:c[4]?BRIGHT:INK}},{text:"  "+c[1],options:{fontSize:11,color:MUTE}}],
    {x:x+0.28,y:cy+0.42,w:cw-0.5,h:0.55,fontSize:30,fontFace:F,margin:0,valign:"middle"});
  s.addText(c[3],{x:x+0.28,y:cy+1.0,w:cw-0.5,h:0.28,fontSize:10.5,color:INK,fontFace:F,margin:0});
});

/* left: revenue sources */
let lx=0.45, ly=2.7;
s.addShape(p.shapes.RECTANGLE,{x:lx,y:ly,w:0.09,h:0.3,fill:{color:ORANGE}});
s.addText("收入来源：收益分成 + 平台授权",{x:lx+0.2,y:ly-0.04,w:4.5,h:0.4,fontSize:15,bold:true,color:INK,fontFace:F,margin:0,valign:"middle"});
s.addText([
  {text:"1. VPP市场收益分成 30%",options:{bold:true,color:ORANGE,breakLine:true}},
  {text:"   现货市场峰谷套利收益",options:{color:MUTE,breakLine:true}},
  {text:"   FCAS 频率控制辅助服务收益",options:{color:MUTE,breakLine:true}},
  {text:"   需求响应(DRM)市场收益",options:{color:MUTE,breakLine:true}},
  {text:"2. BESS托管运营分成（兜底）",options:{bold:true,color:ORANGE,breakLine:true}},
  {text:"   电网级BESS现货套利（190 AUD/MWh）",options:{color:MUTE,breakLine:true}},
  {text:"   FCAS调频收益",options:{color:MUTE,breakLine:true}},
  {text:"   项目测算IRR 22% vs 资方要求IRR 15%",options:{color:INK,breakLine:true}},
  {text:"3. 平台授权 + 通道费",options:{bold:true,color:ORANGE,breakLine:true}},
  {text:"   其他客户年收益的 15%",options:{color:MUTE,breakLine:true}},
  {text:"4. 平台销售和租赁",options:{bold:true,color:ORANGE,breakLine:true}},
  {text:"5. 资本化收益",options:{bold:true,color:ORANGE}},
],{x:lx+0.1,y:ly+0.5,w:4.55,h:4.0,fontSize:11.6,color:INK,fontFace:F,lineSpacingMultiple:1.22,valign:"top"});

/* right: two charts */
let rx=5.25;
s.addText("JV 收入增长轨迹（万 AUD/年）",{x:rx,y:2.6,w:3.9,h:0.32,fontSize:11.5,bold:true,color:INK,fontFace:F});
s.addImage({path:CH+"/p2_growth.png",x:rx-0.1,y:2.95,w:4.05,h:3.55});
s.addText("客户留存率趋势（%）",{x:rx+4.0,y:2.6,w:3.9,h:0.32,fontSize:11.5,bold:true,color:INK,fontFace:F});
s.addImage({path:CH+"/p2_retention.png",x:rx+3.95,y:2.95,w:4.05,h:3.55});

/* source note */
s.addText("注：单位经济性源自AEMO NEM真实数据回测（户用216 / 工商业153 AUD·kW⁻¹·年⁻¹，×30%分成；BESS运营按40,000 AUD/MW·年）。规模口径同第1页。",
  {x:0.45,y:6.62,w:12.4,h:0.3,fontSize:7.8,italic:true,color:MUTE,fontFace:F});

/* floral band */
s.addImage({path:CH+"/p2_floral.png",x:0,y:7.0,w:W,h:0.42});

p.writeFile({fileName:__dirname+"/星星充电_第2页_投入回报分析.pptx"}).then(f=>console.log("WROTE",f));
