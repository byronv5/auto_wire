import { App } from './state.js';
import { $ } from './utils.js';
import { JUNCTION_RADIUS, ROUTE_STUB, MAX_LABEL_STUB_LENGTH, LABEL_STUB_INCREMENT, POWER_TRI_W, POWER_TRI_H, GND_W, GND_H } from './config.js';
import { getNetStyle, offsetPathByLane } from './routing.js';
import { pathHitsObstacle, rectsOverlap, addWireToObstacles } from './geometry.js';
// 新增：从 component.js 导入必要的函数（修复未定义错误）
import { isGndName } from './component.js';  // 如果有 isPowerName 等其他调用，也需添加
import { schdocSync } from './schdocSync.js';

/* ===== 绘图函数 ===== */
export function drawWire(points, netName, customLaneSpacing){
  if(!points||points.length<2) return [];
  const g=$('#g-wires');
  const styledPath=offsetPathByLane(points, netName||'', customLaneSpacing);
  const d=styledPath.map((p,i)=>(i===0?'M':'L')+p.x+' '+p.y).join(' ');
  const path=document.createElementNS('http://www.w3.org/2000/svg','path');
  path.setAttribute('d',d); 
  path.setAttribute('class','wire'); 
  path.setAttribute('data-net',netName||'');
  const st=getNetStyle(netName||'');
  path.setAttribute('stroke',st.stroke);
  if(st.dash){ path.setAttribute('stroke-dasharray',st.dash); }
  path.setAttribute('stroke-width',String(st.width));
  g.appendChild(path); 
  App.wires.push(path);
  
  // 通知schdoc同步器导线已添加
  schdocSync.onWireAdded(path, netName);
  
  return styledPath;
}

export function drawDirectWire(points, netName) {
  if (!points || points.length < 2) return points;
  const g = $('#g-wires');
  const d = points.map((p, i) => (i === 0 ? 'M' : 'L') + p.x + ' ' + p.y).join(' ');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', d);
  path.setAttribute('class', 'wire');
  path.setAttribute('data-net', netName || '');
  const st = getNetStyle(netName || '');
  path.setAttribute('stroke', st.stroke);
  if (st.dash) { path.setAttribute('stroke-dasharray', st.dash); }
  path.setAttribute('stroke-width', String(st.width));
  g.appendChild(path);
  App.wires.push(path);
  
  // 通知schdoc同步器导线已添加
  schdocSync.onWireAdded(path, netName);
  
  return points;
}

export function drawJunctions(points){
  const g=$('#g-junctions');
  points.forEach(p=>{ 
    const c=document.createElementNS('http://www.w3.org/2000/svg','circle'); 
    c.setAttribute('cx',String(p.x)); 
    c.setAttribute('cy',String(p.y)); 
    c.setAttribute('r', String(JUNCTION_RADIUS)); 
    c.setAttribute('class','junction'); 
    g.appendChild(c); 
  });
}

export function drawNetLabel(pt, name, wireOrientation, obstacles, node, suppressJunction = false) {
    // 新增：GND方向优化 - 如果是GND且器件有gndDirection标记，强制向下放置
    if (isGndName(name) && node?.inst?.gndDirection === 'down') {
        wireOrientation = 'H';  // 假设水平线，需要向下标签
        console.log(`[增强标签] 为GND网络 ${name} 强制向下方向 (bottom)`);
    }
  let bestPlacement = null;

  for (let stubLength = ROUTE_STUB; stubLength <= MAX_LABEL_STUB_LENGTH; stubLength += LABEL_STUB_INCREMENT) {
    const directions = (wireOrientation === 'H') ? ['top', 'bottom'] : ['right', 'left'];
    
    for (const side of directions) {
      let labelAnchorPt = { ...pt };
      if (side === 'left')      { labelAnchorPt.x -= stubLength; }
      else if (side === 'right') { labelAnchorPt.x += stubLength; }
      else if (side === 'top')   { labelAnchorPt.y -= stubLength; }
      else                       { labelAnchorPt.y += stubLength; }

      const gTemp = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      const txt = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      txt.setAttribute('class', 'nettag'); 
      txt.textContent = name;
      let x = labelAnchorPt.x, y = labelAnchorPt.y;
      if (side === 'left') { 
        txt.setAttribute('text-anchor', 'end'); 
        x -= 6; y += 3; 
      } else if (side === 'right') { 
        txt.setAttribute('text-anchor', 'start'); 
        x += 6; y += 3; 
      } else if (side === 'top') { 
        txt.setAttribute('text-anchor', 'middle'); 
        y -= 6; 
      } else { 
        txt.setAttribute('text-anchor', 'middle'); 
        y += 12; 
      }
      txt.setAttribute('x', String(x)); 
      txt.setAttribute('y', String(y));
      gTemp.appendChild(txt);
      
      const gNetTags = $('#g-nettags');
      gNetTags.appendChild(gTemp);
      const textBbox = txt.getBBox();
      const labelRect = {
        x: textBbox.x - 2, 
        y: textBbox.y - 1,
        w: textBbox.width + 4, 
        h: textBbox.height + 2
      };
      gNetTags.removeChild(gTemp);

      let collision = false;
      for (const obs of obstacles) {
        if (obs.inst === node?.inst) continue;
        if (rectsOverlap(labelRect, obs)) {
          collision = true; 
          break;
        }
      }
      if (!collision) {
        const excludeInsts = node && node.inst ? [node.inst] : [];
        if (pathHitsObstacle([pt, labelAnchorPt], obstacles, excludeInsts)) {
          collision = true;
        }
      }

      if (!collision) {
        bestPlacement = { side, stubLength, x, y, labelRect };
        break;
      }
    }
    if (bestPlacement) break;
  }

  let finalSide, finalStubLength, finalX, finalY;
  
  if (bestPlacement) {
    finalSide = bestPlacement.side;
    finalStubLength = bestPlacement.stubLength;
    finalX = bestPlacement.x;
    finalY = bestPlacement.y;
  } else {
    finalSide = (wireOrientation === 'H') ? 'top' : 'right';
    finalStubLength = ROUTE_STUB;
    
    let anchor = { ...pt };
    if (finalSide === 'left')      { anchor.x -= finalStubLength; }
    else if (finalSide === 'right') { anchor.x += finalStubLength; }
    else if (finalSide === 'top')   { anchor.y -= finalStubLength; }
    else                            { anchor.y += finalStubLength; }

    finalX = anchor.x; 
    finalY = anchor.y;
    if (finalSide === 'left') { finalX -= 6; finalY += 3; }
    else if (finalSide === 'right') { finalX += 6; finalY += 3; }
    else if (finalSide === 'top') { finalY -= 6; }
    else { finalY += 12; }
  }

  let labelAnchorPt = { ...pt };
  if (finalSide === 'left')      { labelAnchorPt.x -= finalStubLength; }
  else if (finalSide === 'right') { labelAnchorPt.x += finalStubLength; }
  else if (finalSide === 'top')   { labelAnchorPt.y -= finalStubLength; }
  else                            { labelAnchorPt.y += finalStubLength; }
  
  const wirePath = [pt, labelAnchorPt];
  drawDirectWire(wirePath, name);
  addWireToObstacles(wirePath, obstacles);

  if (!suppressJunction) {
    drawJunctions([pt]);
  }
  
  const gFinal = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  const txtFinal = document.createElementNS('http://www.w3.org/2000/svg', 'text');
  txtFinal.setAttribute('class', 'nettag');
  txtFinal.textContent = name;
  txtFinal.setAttribute('x', String(finalX));
  txtFinal.setAttribute('y', String(finalY));
  if (finalSide === 'left') txtFinal.setAttribute('text-anchor', 'end');
  else if (finalSide === 'right') txtFinal.setAttribute('text-anchor', 'start');
  else txtFinal.setAttribute('text-anchor', 'middle');
  
  const gNetTags = $('#g-nettags');
  gNetTags.appendChild(gFinal);
  gFinal.appendChild(txtFinal);
  const finalDomBbox = txtFinal.getBBox();

  const rectFinal = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  rectFinal.setAttribute('class', 'nettag-box');
  rectFinal.setAttribute('x', String(finalDomBbox.x - 2));
  rectFinal.setAttribute('y', String(finalDomBbox.y - 1));
  rectFinal.setAttribute('width', String(finalDomBbox.width + 4));
  rectFinal.setAttribute('height', String(finalDomBbox.height + 2));
  rectFinal.setAttribute('rx', '2');
  gFinal.insertBefore(rectFinal, txtFinal);

  const netLabel = { name, x: finalX, y: finalY };
  App.netLabels.push(netLabel);
  
  // 通知schdoc同步器网络标签已添加
  schdocSync.onNetLabelAdded(netLabel);
  
  const overallBbox = gFinal.getBBox();
  const labelObstacle = { 
    x: overallBbox.x - 2, y: overallBbox.y - 2, 
    w: overallBbox.width + 4, h: overallBbox.height + 4, 
    inst: null 
  };
  obstacles.push(labelObstacle);
  
  return labelObstacle;
}

function addPowerObstacle(rect){ 
  App.powerObstacles.push(rect); 
}

export function drawVCCSymbolAt(anchor,netName){
  const g=$('#g-power-symbols'); 
  const group=document.createElementNS('http://www.w3.org/2000/svg','g');
  const tri=document.createElementNS('http://www.w3.org/2000/svg','path');
  tri.setAttribute('d',`M ${anchor.x} ${anchor.y} L ${anchor.x-POWER_TRI_W/2} ${anchor.y-POWER_TRI_H} L ${anchor.x+POWER_TRI_W/2} ${anchor.y-POWER_TRI_H} Z`);
  tri.setAttribute('fill','var(--vcc)'); 
  tri.setAttribute('stroke','none'); 
  group.appendChild(tri);
  const txt=document.createElementNS('http://www.w3.org/2000/svg','text');
  txt.setAttribute('class','power-text vcc'); 
  txt.setAttribute('x',String(anchor.x)); 
  txt.setAttribute('y',String(anchor.y-POWER_TRI_H-4));
  txt.setAttribute('text-anchor','middle'); 
  txt.textContent=netName||'VCC'; 
  group.appendChild(txt);
  g.appendChild(group);
  addPowerObstacle({
    x:anchor.x-POWER_TRI_W/2-2,
    y:anchor.y-POWER_TRI_H-16,
    w:POWER_TRI_W+4,
    h:POWER_TRI_H+18
  });
  
  // 通知schdoc同步器电源端口已添加
  schdocSync.onPowerPortAdded({ name: netName || 'VCC', x: anchor.x, y: anchor.y });
}

export function drawGNDSymbolAt(anchor,netName){
  const g=$('#g-power-symbols'); 
  const group=document.createElementNS('http://www.w3.org/2000/svg','g');
  const p=document.createElementNS('http://www.w3.org/2000/svg','path');
  p.setAttribute('d',`M ${anchor.x-GND_W/2} ${anchor.y+6} L ${anchor.x+GND_W/2} ${anchor.y+6}
                       M ${anchor.x-GND_W/2+3} ${anchor.y+10} L ${anchor.x+GND_W/2-3} ${anchor.y+10}
                       M ${anchor.x-GND_W/2+6} ${anchor.y+14} L ${anchor.x+GND_W/2-6} ${anchor.y+14}`);
  p.setAttribute('stroke','var(--gnd)'); 
  p.setAttribute('fill','none'); 
  p.setAttribute('stroke-width','2'); 
  group.appendChild(p);
  const txt=document.createElementNS('http://www.w3.org/2000/svg','text');
  txt.setAttribute('class','power-text gnd'); 
  txt.setAttribute('x',String(anchor.x)); 
  txt.setAttribute('y',String(anchor.y+GND_H+6));
  txt.setAttribute('text-anchor','middle'); 
  txt.textContent=netName||'GND'; 
  group.appendChild(txt);
  g.appendChild(group);
  addPowerObstacle({
    x:anchor.x-GND_W/2-2,
    y:anchor.y,
    w:GND_W+4,
    h:GND_H+16
  });
  
  // 通知schdoc同步器电源端口已添加
  schdocSync.onPowerPortAdded({ name: netName || 'GND', x: anchor.x, y: anchor.y });
}