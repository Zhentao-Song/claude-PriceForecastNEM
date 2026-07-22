const pptx=require("pptxgenjs");
const CH=__dirname+"/charts";
const ORANGE="EC6A2C", BRIGHT="F0531F", TINT="FCEEE3", GREY="F3F3F3",
      INK="2E2E2E", MUTE="6E6E6E", LINE="E2E2E2", WHITE="FFFFFF";
const F="PingFang SC";
let p=new pptx(); p.defineLayout({name:"W",width:13.333,height:7.5}); p.layout="W";
const W=13.333,H=7.5;

function header(s,title,sub){
  s.addShape(p.shapes.RECTANGLE,{x:0.45,y:0.4,w:0.5,h:0.07,fill:{color:ORANGE}});
  s.addText(title,{x:1.0,y:0.16,w:5.2,h:0.6,fontSize:25,bold:true,color:INK,fontFace:F,valign:"middle"});
  s.addText(sub,{x:1.0,y:0.74,w:8,h:0.3,fontSize:12,color:MUTE,fontFace:F,valign:"middle"});
  s.addImage({path:CH+"/p2_logo.png",x:10.85,y:0.16,w:0.6,h:0.6});
  s.addText([{text:"StarCharge",options:{bold:true,color:INK,breakLine:true}},{text:"星星充电",options:{color:ORANGE,bold:true}}],
    {x:11.5,y:0.14,w:1.8,h:0.66,fontSize:12.5,fontFace:F,valign:"middle",align:"left",lineSpacingMultiple:1.0,margin:0});
  s.addImage({path:CH+"/p2_floral.png",x:0,y:7.0,w:W,h:0.42});
}
function subhead(s,x,y,txt,w){
  s.addShape(p.shapes.RECTANGLE,{x,y:y+0.02,w:0.09,h:0.3,fill:{color:ORANGE}});
  s.addText(txt,{x:x+0.2,y,w:(w||5),h:0.36,fontSize:15,bold:true,color:INK,fontFace:F,margin:0,valign:"middle"});
}
function card(s,x,y,w,h,c){ s.addShape(p.shapes.RECTANGLE,{x,y,w,h,fill:{color:c||GREY}}); }

/* ================= SLIDE 1 ================= */
let s=p.addSlide(); s.background={color:WHITE};
header(s,"商务政策 ①","盘活存量  ·  安装商签约政策");

/* LEFT: 盘活存量 */
let lx=0.45, lw=5.4;
subhead(s,lx,1.2,"盘活存量（户用）",lw);
card(s,lx,1.66,lw,0.92,GREY);
s.addText([
 {text:"技术：",options:{bold:true}},{text:"OTA远程入池（兼容白名单），旧机加装通信模块\n",options:{color:MUTE,breakLine:true}},
 {text:"触达：",options:{bold:true}},{text:"原安装商回访（retrofit佣金）/ OEM App推送 / DTC",options:{color:MUTE}},
],{x:lx+0.2,y:1.74,w:lw-0.4,h:0.76,fontSize:10.5,color:INK,fontFace:F,margin:0,valign:"top",lineSpacingMultiple:1.1});

card(s,lx,2.7,lw,2.5,GREY);
s.addText("商务政策 · 户用存量",{x:lx+0.2,y:2.78,w:lw-0.4,h:0.32,fontSize:12.5,bold:true,color:ORANGE,fontFace:F,margin:0});
s.addText([
 {text:"零门槛、不绑定",options:{bold:true}},{text:"（或12个月），随时退出",options:{color:MUTE,breakLine:true}},
 {text:"收益保底 ≥ $200/年",options:{bold:true}},{text:"（客户正常拿$758，几乎不触发）",options:{color:MUTE,breakLine:true}},
 {text:"入池奖励：",options:{bold:true}},{text:"一次性 $50 账单抵扣",options:{color:MUTE,breakLine:true}},
 {text:"电池健康保障：",options:{bold:true}},{text:"年循环上限 + 衰减补偿",options:{color:MUTE,breakLine:true}},
 {text:"透明 App 收益看板",options:{bold:true}},
],{x:lx+0.2,y:3.2,w:lw-0.4,h:1.9,fontSize:11,color:INK,fontFace:F,margin:0,valign:"top",bullet:{indent:14},lineSpacingMultiple:1.25});

s.addShape(p.shapes.RECTANGLE,{x:lx,y:5.34,w:lw,h:0.62,fill:{color:TINT}});
s.addShape(p.shapes.RECTANGLE,{x:lx,y:5.34,w:0.09,h:0.62,fill:{color:ORANGE}});
s.addText([{text:"一句话：",options:{bold:true,color:BRIGHT}},{text:"不要钱 · 不绑定 · 不伤电池 · 还保底",options:{bold:true,color:INK}}],
 {x:lx+0.2,y:5.34,w:lw-0.3,h:0.62,fontSize:12.5,fontFace:F,valign:"middle",margin:0});

/* RIGHT: 安装商商务政策 */
let rx=6.1, rw=6.78;
subhead(s,rx,1.2,"安装商商务政策（现金 + 非现金）",rw);
const HC={fill:{color:INK},color:WHITE,bold:true};
const rebate=[
 [{text:"客户类型",options:HC},{text:"签约（一次性）",options:HC},{text:"Trailing（3年）",options:HC},{text:"量级阶梯",options:HC},{text:"合计(约)",options:HC}],
 ["户用","$60 / 户","运营商收益5%≈$49","<20户:$60｜20–50:$75｜>50:$90","~$110/户"],
 ["工商业","$300–500 / 站","运营商收益5%≈$688","按项目规模浮动","~$1,000/站"],
];
s.addTable(rebate,{x:rx,y:1.66,w:rw,colW:[1.0,1.25,1.55,1.95,1.03],
  rowH:[0.4,0.62,0.62],fontSize:9.8,fontFace:F,color:INK,align:"center",valign:"middle",
  border:{type:"solid",pt:0.5,color:LINE}});
// header font white bold
// (pptxgenjs uses cell options; set via first row fill already; recolor text)
card(s,rx,3.44,rw,1.32,GREY);
s.addText("非现金激励（往往更管用）",{x:rx+0.2,y:3.5,w:rw-0.4,h:0.3,fontSize:12.5,bold:true,color:ORANGE,fontFace:F,margin:0});
s.addText([
 {text:"帮他多卖硬件：",options:{bold:true}},{text:"给“收益计算器”（用我们的模型算“每台每年多赚$X”），电池回本更快→提高他的成交率，是不花钱的强激励\n",options:{color:MUTE,breakLine:true}},
 {text:"联合品牌 ｜ 认证安装商体系 ｜ 营销物料 ｜ 反向导流 leads",options:{color:MUTE}},
],{x:rx+0.2,y:3.86,w:rw-0.4,h:0.86,fontSize:10.5,color:INK,fontFace:F,margin:0,valign:"top",lineSpacingMultiple:1.12});

card(s,rx,4.88,rw,1.32,TINT);
s.addText("逻辑",{x:rx+0.2,y:4.94,w:rw-0.4,h:0.28,fontSize:12,bold:true,color:BRIGHT,fontFace:F,margin:0});
s.addText([
 {text:"Trailing 分成 + 帮他卖货",options:{bold:true,color:INK}},
 {text:"，把安装商从“一次性中介”变成“长期销售 + 留存伙伴”。资金来自对应毛利（户用 $325/年、工商 $4,587/年），CAC 完全可控。",options:{color:MUTE}},
],{x:rx+0.2,y:5.28,w:rw-0.4,h:0.86,fontSize:10.8,color:INK,fontFace:F,margin:0,valign:"top",lineSpacingMultiple:1.12});

/* ================= SLIDE 2 ================= */
let s2=p.addSlide(); s2.background={color:WHITE};
header(s2,"商务政策 ②","大客户（C&I）VPP 服务  ·  四选一商务菜单");

/* LEFT: 服务内容 */
let ax=0.45, aw=3.95;
subhead(s2,ax,1.2,"服务内容",aw);
card(s2,ax,1.66,aw,3.0,GREY);
s2.addText([
 {text:"现货套利 + FCAS 代运营",options:{bold:true,breakLine:true}},
 {text:"叠加需量管理",options:{bold:true}},{text:"（削峰省 demand charge）\n",options:{color:MUTE,breakLine:true}},
 {text:"SoC 预留",options:{bold:true}},{text:"：备电 / 生产负荷优先，非工作时段才套利\n",options:{color:MUTE,breakLine:true}},
 {text:"月度透明结算 + dashboard",options:{bold:true}},
],{x:ax+0.2,y:1.84,w:aw-0.4,h:2.7,fontSize:11.5,color:INK,fontFace:F,margin:0,valign:"top",bullet:{indent:14},lineSpacingMultiple:1.45});

subhead(s2,ax,4.9,"合同要素",aw);
card(s2,ax,5.36,aw,1.2,TINT);
s2.addText("3–7 年期 · SoC 预留 · 可用率保证 · 月结透明 · 退出条款",
 {x:ax+0.2,y:5.36,w:aw-0.4,h:1.2,fontSize:11.5,color:INK,fontFace:F,margin:0,valign:"middle",lineSpacingMultiple:1.2});

/* RIGHT: 四选一菜单 */
let bx=4.6, bw=8.28;
subhead(s2,bx,1.2,"商务菜单（四选一，按客户偏好）",bw);
const menu=[
 [{text:"模式",options:HC},{text:"客户得到",options:HC},{text:"你（运营商）得到",options:HC},{text:"适合",options:HC}],
 ["A  标准分成 70/30","留 70%（$10,703/年）","30%（$4,587）· 零风险","先试水"],
 [{text:"B  保底 + 分成 ★主推",options:{fill:{color:TINT},bold:true}},{text:"保底 ≥ $9,000/年 + 超额分成",options:{fill:{color:TINT}}},{text:"30% above · 给足确定性",options:{fill:{color:TINT}}},{text:"要确定性的 CFO",options:{fill:{color:TINT}}}],
 ["C  容量租赁 / tolling","固定 $50/kW·年（$5,000）","全部市场收益+风险（净~$9–11k）","只想要张支票"],
 ["D  EaaS 共同投资","零 capex 装电池","收益+服务费回收 · 做大资产盘","不愿掏 capex（IRR 22%）"],
];
s2.addTable(menu,{x:bx,y:1.66,w:bw,colW:[2.05,2.35,2.4,1.48],
  rowH:[0.42,0.62,0.7,0.62,0.62],fontSize:10,fontFace:F,color:INK,align:"center",valign:"middle",
  border:{type:"solid",pt:0.5,color:LINE}});

card(s2,bx,4.95,bw,1.55,GREY);
s2.addText("放量逻辑",{x:bx+0.2,y:5.03,w:bw-0.4,h:0.3,fontSize:12.5,bold:true,color:ORANGE,fontFace:F,margin:0});
s2.addText([
 {text:"B（保底）",options:{bold:true,color:BRIGHT}},{text:" 拿信任、好做立项；",options:{color:MUTE}},
 {text:"D（EaaS）",options:{bold:true,color:BRIGHT}},{text:" 拿那些不愿掏 capex 的客户——你出资装电池，用收益流（IRR 22% > 资方 15%）把“卖服务”变成“做大资产盘”。\n",options:{color:MUTE,breakLine:true}},
 {text:"四种模式的资金都能从对应毛利覆盖，不穿底；客户按风险偏好自选，转化率最高。",options:{color:MUTE}},
],{x:bx+0.2,y:5.4,w:bw-0.4,h:1.05,fontSize:10.8,color:INK,fontFace:F,margin:0,valign:"top",lineSpacingMultiple:1.12});

p.writeFile({fileName:__dirname+"/星星充电_商务政策.pptx"}).then(f=>console.log("WROTE",f));
