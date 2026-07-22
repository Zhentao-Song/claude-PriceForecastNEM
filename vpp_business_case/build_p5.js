const pptx=require("pptxgenjs");
const CH=__dirname+"/charts";
const ORANGE="EC6A2C", BRIGHT="F0531F", TINT="FCEEE3", GREY="F3F3F3",
      INK="2E2E2E", MUTE="6E6E6E", LINE="E2E2E2", WHITE="FFFFFF";
const F="PingFang SC";
let p=new pptx(); p.defineLayout({name:"W",width:13.333,height:7.5}); p.layout="W";
const W=13.333,H=7.5;
let s=p.addSlide(); s.background={color:WHITE};

/* header */
s.addShape(p.shapes.RECTANGLE,{x:0.45,y:0.36,w:0.5,h:0.07,fill:{color:ORANGE}});
s.addText("商务政策",{x:1.0,y:0.12,w:5,h:0.56,fontSize:25,bold:true,color:INK,fontFace:F,valign:"middle"});
s.addText("盘活存量  ·  安装商签约  ·  大客户 VPP（四选一）",{x:1.0,y:0.66,w:9,h:0.3,fontSize:12,color:MUTE,fontFace:F,valign:"middle"});
s.addImage({path:CH+"/p2_logo.png",x:10.85,y:0.12,w:0.58,h:0.58});
s.addText([{text:"StarCharge",options:{bold:true,color:INK,breakLine:true}},{text:"星星充电",options:{color:ORANGE,bold:true}}],
  {x:11.5,y:0.1,w:1.8,h:0.64,fontSize:12,fontFace:F,valign:"middle",align:"left",lineSpacingMultiple:1.0,margin:0});
s.addImage({path:CH+"/p2_floral.png",x:0,y:7.0,w:W,h:0.42});

function subhead(x,y,txt,w){
  s.addShape(p.shapes.RECTANGLE,{x,y:y+0.02,w:0.08,h:0.28,fill:{color:ORANGE}});
  s.addText(txt,{x:x+0.18,y,w:(w||6),h:0.34,fontSize:14,bold:true,color:INK,fontFace:F,margin:0,valign:"middle"});
}
function card(x,y,w,h,c){ s.addShape(p.shapes.RECTANGLE,{x,y,w,h,fill:{color:c||GREY}}); }

/* ===== TOP-LEFT: 盘活存量 ===== */
let lx=0.45, lw=6.1;
subhead(lx,1.05,"① 盘活存量（户用）",lw);
card(lx,1.5,lw,2.28,GREY);
s.addText([
 {text:"零门槛、不绑定",options:{bold:true}},{text:"（或12个月），随时退出\n",options:{color:MUTE,breakLine:true}},
 {text:"收益保底 ≥ $200/年",options:{bold:true}},{text:"（客户正常拿$758，几乎不触发）\n",options:{color:MUTE,breakLine:true}},
 {text:"入池奖励 一次性 $50 账单抵扣",options:{bold:true}},{text:"｜",options:{color:LINE}},{text:"透明 App 看板\n",options:{bold:true,breakLine:true}},
 {text:"电池健康保障",options:{bold:true}},{text:"：年循环上限 + 衰减补偿\n",options:{color:MUTE,breakLine:true}},
 {text:"触达：",options:{bold:true}},{text:"原安装商回访 / OEM App / DTC；",options:{color:MUTE}},{text:"技术：",options:{bold:true}},{text:"OTA远程入池",options:{color:MUTE}},
],{x:lx+0.2,y:1.62,w:lw-0.4,h:1.55,fontSize:10.5,color:INK,fontFace:F,margin:0,valign:"top",lineSpacingMultiple:1.22});
s.addShape(p.shapes.RECTANGLE,{x:lx+0.2,y:3.28,w:lw-0.4,h:0.42,fill:{color:TINT}});
s.addText([{text:"一句话：",options:{bold:true,color:BRIGHT}},{text:"不要钱 · 不绑定 · 不伤电池 · 还保底",options:{bold:true,color:INK}}],
 {x:lx+0.33,y:3.28,w:lw-0.6,h:0.42,fontSize:11.5,fontFace:F,valign:"middle",margin:0});

/* ===== TOP-RIGHT: 安装商签约 ===== */
let rx=6.78, rw=6.1;
subhead(rx,1.05,"② 安装商签约政策",rw);
card(rx,1.5,rw,2.28,GREY);
s.addText([
 {text:"户用：",options:{bold:true,color:ORANGE}},{text:"签约 $60 + 3年trailing 5%(≈$49) + 阶梯(<20:$60/20–50:$75/>50:$90) ",options:{}},{text:"≈ $110/户\n",options:{bold:true,breakLine:true}},
 {text:"工商：",options:{bold:true,color:ORANGE}},{text:"签约 $300–500 + trailing 5%(≈$688) ",options:{}},{text:"≈ $1,000/站\n",options:{bold:true,breakLine:true}},
 {text:"非现金（更管用）：",options:{bold:true}},{text:"收益计算器(用我们模型，电池回本更快→提高成交) · 联合品牌 · 认证体系 · leads\n",options:{color:MUTE,breakLine:true}},
 {text:"资金来自对应毛利",options:{bold:true}},{text:"（户用$325/年、工商$4,587/年），CAC可控；trailing让安装商变“长期销售+留存伙伴”。",options:{color:MUTE}},
],{x:rx+0.2,y:1.64,w:rw-0.4,h:2.05,fontSize:10.5,color:INK,fontFace:F,margin:0,valign:"top",lineSpacingMultiple:1.2});

/* ===== BOTTOM: C&I 四选一 ===== */
subhead(0.45,3.9,"③ 大客户（C&I）四选一商务菜单",6.5);
s.addText("服务：现货+FCAS+需量管理 · 负荷优先(SoC预留) · 3–7年 · 月结透明",
 {x:7.0,y:3.9,w:5.9,h:0.34,fontSize:10,italic:true,color:MUTE,fontFace:F,align:"right",valign:"middle"});
const HC={fill:{color:INK},color:WHITE,bold:true};
const T=t=>({text:t,options:{fill:{color:TINT}}});
const menu=[
 [{text:"模式",options:HC},{text:"客户得到",options:HC},{text:"你（运营商）得到",options:HC},{text:"适合",options:HC}],
 ["A  标准分成 70/30","留 70%（$10,703/年）","30%（$4,587）· 零风险","先试水"],
 [{text:"B  保底 + 分成  ★主推",options:{fill:{color:TINT},bold:true}},T("保底 ≥ $9,000/年 + 超额分成"),T("30% above · 给足确定性"),T("要确定性的 CFO")],
 ["C  容量租赁 / tolling","固定 $50/kW·年（$5,000）","全部市场收益+风险（净 ~$9–11k）","只想要张支票"],
 ["D  EaaS 共同投资","零 capex 装电池","收益+服务费回收 · 做大资产盘","不愿掏 capex（IRR 22%）"],
];
s.addTable(menu,{x:0.45,y:4.3,w:12.43,colW:[2.7,3.5,3.63,2.6],
 rowH:[0.34,0.4,0.44,0.4,0.4],fontSize:10.5,fontFace:F,color:INK,align:"center",valign:"middle",
 border:{type:"solid",pt:0.5,color:LINE}});
s.addText([{text:"放量：",options:{bold:true,color:BRIGHT}},
 {text:"B（保底）拿信任、好立项；D（EaaS）你出资装电池、用收益流(IRR 22%>15%)把“卖服务”变“做大资产盘”。四种资金均由毛利覆盖、不穿底，客户按风险偏好自选。",options:{color:MUTE}}],
 {x:0.45,y:6.46,w:12.43,h:0.32,fontSize:9.6,fontFace:F,margin:0,valign:"middle"});

p.writeFile({fileName:__dirname+"/星星充电_商务政策_单页.pptx"}).then(f=>console.log("WROTE",f));
