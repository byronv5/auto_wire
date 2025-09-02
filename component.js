import { App } from './state.js';
import { $, toast, uuid } from './utils.js';
import { pickSymbol, genPlaceholder, prefixIDs } from './symbol.js';

/* ===== 符号/器件处理与管理 ===== */
function buildSymbolNode(inst){
  try{
    const parser=new DOMParser(); 
    const doc=parser.parseFromString(inst.symbol.svgText,'image/svg+xml');
    const svgInner=doc.documentElement; 
    prefixIDs(svgInner,inst.id+'_');
    const vb=(svgInner.getAttribute('viewBox')||'0 0 100 60').split(/\s+/).map(Number);
    const w=Math.max(1,Math.round(vb[2]||inst.symbol.w||100));
    const h=Math.max(1,Math.round(vb[3]||inst.symbol.h||60));
    svgInner.setAttribute('width',String(w)); 
    svgInner.setAttribute('height',String(h));
    return document.importNode(svgInner,true);
  }catch(e){
    const g=document.createElementNS('http://www.w3.org/2000/svg','g');
    const r=document.createElementNS('http://www.w3.org/2000/svg','rect');
    r.setAttribute('x','0'); 
    r.setAttribute('y','0'); 
    r.setAttribute('width',String(inst.symbol?.w||120)); 
    r.setAttribute('height',String(inst.symbol?.h||60));
    r.setAttribute('fill','#FFE'); 
    r.setAttribute('stroke','#8B0000'); 
    g.appendChild(r); 
    return g;
  }
}

export function effSize(inst){ 
  const w=inst.symbol.w,h=inst.symbol.h; 
  if((inst.rot%180+180)%180===0) return {w,h}; 
  return {w:h,h:w}; 
}

function localToEffForAngle(inst,x,y,angle){
  angle=((angle%360)+360)%360; 
  const w=inst.symbol.w,h=inst.symbol.h;
  if(angle===0) return {x,y};
  if(angle===90) return {x:h-y,y:x};
  if(angle===180) return {x:w-x,y:h-y};
  if(angle===270) return {x:y,y:w-x};
  return {x,y};
}

function localToEff(inst,x,y){ 
  return localToEffForAngle(inst,x,y,inst.rot||0); 
}

export function pinAbsCoord(inst,pin){ 
  const p=localToEff(inst,pin.x,pin.y); 
  return {x:inst.x+p.x,y:inst.y+p.y}; 
}

export function instTransform(inst){
  const a=((inst.rot||0)%360+360)%360; 
  const w=inst.symbol.w,h=inst.symbol.h;
  if(a===0) return `translate(${inst.x},${inst.y})`;
  if(a===90) return `translate(${inst.x+h},${inst.y}) rotate(90)`;
  if(a===180) return `translate(${inst.x+w},${inst.y+h}) rotate(180)`;
  if(a===270) return `translate(${inst.x},${inst.y+w}) rotate(270)`;
  return `translate(${inst.x},${inst.y})`;
}

export function pinAbsByNumber(inst,num){
  if(!inst||!Array.isArray(inst.pins)) return null;
  const p=inst.pins.find(pp=>String(pp.number)===String(num));
  if(!p) return null;
  const a=pinAbsCoord(inst,p);
  return {x:a.x,y:a.y};
}

export function sideOfPinOnInst(inst,absPt){
  const s=effSize(inst);
  const rx=absPt.x - inst.x;
  const ry=absPt.y - inst.y;
  const d=[
    {side:'left',  d:Math.abs(rx-0)},
    {side:'right', d:Math.abs(s.w-rx)},
    {side:'top',   d:Math.abs(ry-0)},
    {side:'bottom',d:Math.abs(s.h-ry)}
  ].sort((a,b)=>a.d-b.d);
  return d[0].side;
}

function rebuildRefIndex(){ 
  App.byRef=new Map(App.inst.map(i=>[i.ref,i])); 
}

export function clearCanvas(){
  App.inst=[]; 
  App.wires=[]; 
  App.netLabels=[]; 
  App.byRef=new Map(); 
  App.powerObstacles=[];
  App.qualityReport=null;
  $('#g-symbols').innerHTML=''; 
  $('#g-wires').innerHTML=''; 
  $('#g-junctions').innerHTML=''; 
  $('#g-power-symbols').innerHTML=''; 
  $('#g-nettags').innerHTML=''; 
  $('#g-rubber').innerHTML='';
  $('#inst-count').textContent='0'; 
  $('#wire-count').textContent='0'; 
  $('#label-count').textContent='0'; 
  $('#success-rate').textContent='--'; 
  $('#optimization-count').textContent='0';
  $('#critical-count').textContent='0';
  $('#quality-indicator').style.display='none';
  $('#quality-report').style.display='none';
  App.stats.optimizedComponents = 0;
  App.stats.criticalCircuits = 0;
  toast('画布已清空','ok');
}

export function buildInstances(){
  const unmatched=[];
  App.inst=(App.plan.components||[]).map((c,idx)=>{
    const sym=pickSymbol(c)||genPlaceholder(c); 
    if(!pickSymbol(c)) unmatched.push(`${c.ref}(${c.value||c.symbolKey||'无'})`);
    const pins=Array.isArray(sym.pins)?sym.pins.slice():[];
    return {
      id:uuid(),
      ref:c.ref,
      value:c.value||'',
      symbol:{...sym,pins},
      x:100+idx*180,
      y:120,
      pins,
      rot:0
    };
  });
  if(unmatched.length) toast('部分器件未命中库，已用占位符：'+unmatched.join('、'),'warn',5200);
  rebuildRefIndex(); 
  renderInstances(); 
  $('#inst-count').textContent=String(App.inst.length);
}

export function renderInstances(){
  const g=$('#g-symbols'); 
  g.innerHTML='';
  App.inst.forEach(inst=>{
    const el=document.createElementNS('http://www.w3.org/2000/svg','g');
    el.classList.add('symbol'); 
    el.setAttribute('data-id',inst.id); 
    el.setAttribute('data-ref',inst.ref); 
    el.setAttribute('transform',instTransform(inst));
    const sub=buildSymbolNode(inst); 
    el.appendChild(sub);
    const size=effSize(inst);
    const t=document.createElementNS('http://www.w3.org/2000/svg','text');
    t.setAttribute('class','ref'); 
    t.setAttribute('x',String(size.w/2)); 
    t.setAttribute('y','-6'); 
    t.setAttribute('text-anchor','middle');
    t.textContent=inst.ref + (inst.value?(' ('+inst.value+')'):''); 
    el.appendChild(t); 
    g.appendChild(el);
  });
}

/* ===== 器件类型检测 ===== */
// 最终修正版：增强网络名称识别的健壮性，使其能处理各种命名变体

export function isPowerName(name){ 
  const upperName = String(name || '').toUpperCase().trim();
  if (!upperName) return false;
  // 检查是否完全匹配核心电源名称，或者是否以这些名称开头/结尾 (例如 VCC_1, 5V_IN)
  return /^(VCC|VDD|VEE|VBUS|VIN|AVDD|DVDD|VREF)$/.test(upperName) || 
         /^\+?(\d+V\d*|\d+\.\d+V)/.test(upperName) || // 匹配 5V, 3V3, 3.3V, 1V8 等
         upperName.includes('VCC') || // 额外检查是否包含 'VCC'
         upperName.includes('VDD');
}

export function isGndName(name){ 
  const upperName = String(name || '').toUpperCase().trim();
  if (!upperName) return false;
  // 检查是否完全匹配核心地名称，或者是否包含这些名称
  return /^(GND|VSS)$/.test(upperName) || 
         upperName.includes('GND') || // 匹配 AGND, DGND, PGND 等
         upperName.includes('VSS');
}
export function isResetName(name) {
  return /^(RESET|RST|NRST|NRESET|MCLR)$/i.test(String(name||''));
}
// 在 isResetName 函数后添加以下代码（文件末尾）
export function isInductorName(name) {
    const upperName = String(name || '').toUpperCase().trim();
    if (!upperName) return false;
    // 检查是否匹配电感相关名称（类似于 isPowerName 的实现）
    return /^(L|INDUCTOR|COIL|CHOKE)$/.test(upperName) || 
           upperName.includes('INDUCTOR') || 
           upperName.includes('COIL') || 
           upperName.includes('CHOKE') || 
           upperName.startsWith('L');  // 匹配 L1, L2 等常见电感引用
}

export function isConnector(inst){
  const ref=(inst?.ref||'').toUpperCase(); 
  const key=(inst?.symbol?.key||'').toLowerCase(); 
  const val=(inst?.value||'').toLowerCase();
  return (/^J\d+/.test(ref)||/^P\d+/.test(ref)||/^K\d+/.test(ref)||/^CN\d+/.test(ref)||/header|hdr|connector|conn|socket|port|plug|jack|usb|dcjack/.test(key+val));
}

export function detectType(inst){
  const ref=(inst?.ref||'').toUpperCase(); 
  const key=(inst?.symbol?.key||'').toLowerCase(); 
  const val=(inst?.value||'').toLowerCase();
  const isMCU=/mcu|microcontroller|stm32|esp32|esp8266|atmega|attiny|nrf|samd|8051|mcs51|avr|rp2040|89c51|at89c51/.test(key+val);
  const isConn=isConnector(inst);
  if(isConn) return 'Connector';
  if(/^C\d+/.test(ref)||/cap|电容/.test(val)) return 'Capacitor';
  if(/^R\d+/.test(ref)||/res|电阻/.test(val)) return 'Resistor';
  if(/^L\d+/.test(ref)||/inductor|电感/.test(val)) return 'Inductor';
  if(/^D\d+/.test(ref)||/diode|肖特基|二极管|1n4148/.test(val)) return 'Diode';
  if(/^Y\d+/.test(ref)||/^X\d+/.test(ref)||/crystal|xtal|resonator|晶振/.test(key+val)) return 'Crystal';
  if(/^U\d+/.test(ref)||/fpga|cpu|soc|ic|opamp|sensor|adc|dac|driver|cpld/.test(key+val)||(inst.pins?.length||0)>=8) return isMCU?'MCU':'IC';
  return 'Misc';
}