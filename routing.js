import { App } from './state.js';
import { $, snap, uuid } from './utils.js';
import { WIRE_WIDTH, LANE_SPACING, LANE_SPACING_TIGHT, NET_LOCALITY_THRESHOLD, LANE_MAX, ROUTE_STUB, ROUTE_STUB_IC, DEFAULT_VB, TURN_PENALTY, BACKWARDS_PENALTY, MAX_WIRE_LENGTH, GRID, POWER_STUB_IC, POWER_STUB, TRUNK_SCAN_STEPS, TRUNK_EXTRA, LOCAL_CLUSTER_RADIUS, POWER_TRI_W, POWER_TRI_H, GND_W, GND_H } from './config.js';
import { isPowerName, isGndName, pinAbsByNumber, sideOfPinOnInst, detectType, effSize, pinAbsCoord } from './component.js';
import { rectForInstRoute, lineHitsObstacles, pathHitsObstacle, pointInRect, segIntersectsRect, addWireToObstacles, rectsOverlap } from './geometry.js';
import { drawWire, drawDirectWire, drawJunctions, drawNetLabel, drawVCCSymbolAt, drawGNDSymbolAt } from './drawing.js';
import { optimizeAllComponents } from './optimization.js';

/* ===== 布线引擎与相关函数 ===== */

function placePowerSymbolNearPin(node, netName, isVCC, obstaclesDyn){
    const inst = node.inst; 
    const exInsts = inst ? [inst] : []; 
    const dir = isVCC ? -1 : 1;
    const Lmin = (inst && (detectType(inst) === 'MCU' || detectType(inst) === 'IC')) ? POWER_STUB_IC : POWER_STUB;
    
    // 新增：检查实例是否有gndDirection标记（从布局传入）
    const gndDirection = inst?.gndDirection || 'down';  // 默认向下
    const forceDown = !isVCC && gndDirection === 'down';  // 对于GND强制向下
    
    for(let L = Lmin; L <= Lmin + 40; L += GRID){
        const dxCandidates = [0, -GRID, GRID, -2*GRID, 2*GRID];
        for(const dx of dxCandidates){
            const p1 = {x: node.x, y: node.y}, 
                  p2 = {x: node.x + dx, y: node.y}, 
                  end = {x: node.x + dx, y: node.y + dir * L};
            
            // 新增：如果forceDown，调整end.y为向下
            if (forceDown) {
                end.y = node.y + L;  // 强制向下（正Y方向假设向下）
            }
            
            if(dx !== 0 && lineHitsObstacles(p1, p2, obstaclesDyn, exInsts)) continue;
            if(lineHitsObstacles(p2, end, obstaclesDyn, exInsts)) continue;
            
            const symRect = isVCC ? {
                x: end.x - POWER_TRI_W / 2 - 2,
                y: end.y - POWER_TRI_H - 16,
                w: POWER_TRI_W + 4,
                h: POWER_TRI_H + 18
            } : {
                x: end.x - GND_W / 2 - 2,
                y: end.y,
                w: GND_W + 4,
                h: GND_H + 16
            };
            
            let overlap = false; 
            for(const o of obstaclesDyn){ 
                if(rectsOverlap(symRect, o)){
                    overlap = true;
                    break;
                } 
            }
            if(overlap) continue;
            
            let wirePath = [];
            if(dx !== 0) {
                const p = drawDirectWire([p1, p2], netName);
                wirePath.push(...p);
            }
            const p_end = drawDirectWire([p2, end], netName);
            wirePath.push(...p_end);
            addWireToObstacles(simplifyPath(wirePath), obstaclesDyn);
            
            drawJunctions([p1]);
            if(isVCC) drawVCCSymbolAt(end, netName); 
            else drawGNDSymbolAt(end, netName);
            return { success: true };
        }
    }
    return { success: false };
}

/**
 * 为重复电路组创建共用电源/地母线
 * @param {Array} repeatedGroups - 从布局引擎识别出的重复电路组
 * @param {Array} obstacles - 当前的障碍物列表
 * @param {Map} pinIndex - 全局引脚索引，用于查找完整的节点对象
 * @returns {Set<string>} 返回被此函数处理过的所有节点的ID集合
 */
function routeRepeatedCircuitsWithBus(repeatedGroups, obstacles, pinIndex) {
    try {  // 新增：try 块开始，捕获潜在错误
        console.log(`[Routing] Entering routeRepeatedCircuitsWithBus...`);
        const handledNodeIds = new Set();
        const busMap = new Map();  // Track buses for merging (key: signal type like 'GND', value: bus paths)

        // Process all groups (now supports BUTTON and LED)
        for (const group of repeatedGroups) {
            if (!group.type.includes('BUTTON') && !group.type.includes('LED')) {
                console.log(`[Routing] Skipping non-supported group: ${group.type}`);
                continue;
            }

            // Collect nodes for shared signals (GND/VCC for buttons, VCC for LEDs)
            const sharedSignal = group.type.includes('BUTTON') ? 'GND' : 'VCC';  // Extend for LED
            const sharedNodes = [];
            group.circuits.forEach(circuitData => {
                const mainComp = circuitData.circuit.components.find(c => c.type === 'Switch' || c.type === 'LED');
                if (!mainComp) return;

                const inst = mainComp.inst;
                for (const pin of inst.pins) {
                    const connectedNet = App.plan.nets.find(net => 
                        net.nodes.some(node => node.ref === inst.ref && node.pin == pin.number)
                    );
                    if (connectedNet && (sharedSignal === 'GND' ? isGndName(connectedNet.name) : isPowerName(connectedNet.name))) {
                        const key = `${inst.ref}.${pin.number}`;
                        const node = pinIndex.get(key);
                        if (node) {
                            sharedNodes.push(node);
                            handledNodeIds.add(node.id);
                            break;
                        }
                    }
                }
            });

            console.log(`[Routing] Collected ${sharedNodes.length} nodes for ${sharedSignal} in group ${group.type}`);

            // Create or extend bus
            if (sharedNodes.length > 1) {
                const busPath = createOrExtendBus(sharedNodes, sharedSignal, obstacles, busMap);
                if (busPath) {
                    drawDirectWire(busPath, sharedSignal);
                    addWireToObstacles(busPath, obstacles);
                    sharedNodes.forEach(node => {
                        drawDirectWire([node, getClosestBusPoint(node, busPath)], sharedSignal);
                    });
                    // Place symbol at bus end (e.g., GND symbol)
                    const endPoint = busPath[busPath.length - 1];
                    if (sharedSignal === 'GND') drawGNDSymbolAt(endPoint, 'GND');
                    else drawVCCSymbolAt(endPoint, 'VCC');
                    drawJunctions(sharedNodes.map(n => ({x: n.x, y: n.y})));
                }
            }
        }

        // Merge nearby buses across groups
        mergeNearbyBuses(busMap, obstacles);

        return handledNodeIds;
    } catch (error) {  // 新增：catch 块，捕获错误
        console.error('%c[总线处理错误] 捕获异常: ', 'color: red; font-weight: bold;', error);
        return new Set();  // 返回空 Set，继续后续布线（防止整个 routeAllNets() 中断）
    }
}

// New Helper: Create or extend a bus for nodes
function  createOrExtendBus(nodes, signal, obstacles, busMap) {
    const xs = nodes.map(n => n.x);
    const ys = nodes.map(n => n.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const spanX = maxX - minX;
    const spanY = maxY - minY;
    const orient = spanY > spanX ? 'V' : 'H';

    let busPath;
    if (orient === 'V') {
        const busX = Math.min(...xs) - 20;  // Left of group
        busPath = [{x: busX, y: minY - 5}, {x: busX, y: maxY + 5}];
    } else {
        const busY = Math.min(...ys) - 20;  // Above group
        busPath = [{x: minX - 5, y: busY}, {x: maxX + 5, y: busY}];
    }

    // Check for existing bus to extend
    if (busMap.has(signal)) {
        const existingBus = busMap.get(signal);
        if (canMergeBuses(existingBus, busPath)) {
            busPath = extendBus(existingBus, busPath);
        }
    }

    // Validate no obstacles
    if (!lineHitsObstacles(busPath[0], busPath[1], obstacles)) {
        busMap.set(signal, busPath);  // Update map
        return busPath;
    }
    return null;
}

// New Helper: Get closest point on bus to a node
function getClosestBusPoint(node, busPath) {
  let closest = busPath[0];
  let minDist = Math.hypot(node.x - closest.x, node.y - closest.y);
  for (const point of busPath) {
    const dist = Math.hypot(node.x - point.x, node.y - point.y);
    if (dist < minDist) {
      minDist = dist;
      closest = point;
    }
  }
  return closest;
}
// New Helper: Merge nearby buses
function mergeNearbyBuses(busMap, obstacles) {
    const signals = [...busMap.keys()];
    for (let i = 0; i < signals.length; i++) {
        for (let j = i + 1; j < signals.length; j++) {
            if (signals[i] !== signals[j]) continue;  // 只合并同信号
            const bus1 = busMap.get(signals[i]);
            const bus2 = busMap.get(signals[j]);
            if (canMergeBuses(bus1, bus2)) {  // 假设有canMergeBuses函数
                const merged = extendBus(bus1, bus2);
                busMap.set(signals[i], merged);  // 更新
                busMap.delete(signals[j]);  // 删除旧的
                // 绘制连接线如果需要
                drawDirectWire([bus1[bus1.length-1], bus2[0]], signals[i]);
            }
        }
    }
}

// 添加：在mergeNearbyBuses后添加（如果缺失）canMergeBuses和extendBus
function canMergeBuses(bus1, bus2) {
    // 示例：检查端点距离<阈值50px
    const dist = Math.hypot(bus1[bus1.length-1].x - bus2[0].x, bus1[bus1.length-1].y - bus2[0].y);
    return dist < 50;
}

function extendBus(bus1, bus2) {
    return [...bus1, ...bus2];  // 简单扩展
}

// --- 路径简化与分道 ---
function simplifyPath(path) {
  if (!path || path.length <= 2) return path;
  const finalPath = [path[0]];
  for (let i = 1; i < path.length - 1; i++) {
    const p1 = finalPath[finalPath.length - 1];
    const p2 = path[i];
    const p3 = path[i + 1];
    const isCollinear = (p1.x === p2.x && p2.x === p3.x) || (p1.y === p2.y && p2.y === p3.y);
    if (!isCollinear) {
      finalPath.push(p2);
    }
  }
  finalPath.push(path[path.length - 1]);
  return finalPath;
}

export function offsetPathByLane(points, net, customLaneSpacing){
  if(!points||points.length<2) return points;
  
  const spacing = customLaneSpacing !== undefined ? customLaneSpacing : LANE_SPACING;

  const out=[{x:points[0].x,y:points[0].y}];
  const segCount=points.length-1;
  let prevDelta={dx:0,dy:0};

  for(let i=0;i<segCount;i++){
    const a=points[i], b=points[i+1];
    const isH=a.y===b.y, isV=a.x===b.x;

    if(!isH && !isV){
      const last=out[out.length-1];
      if(last.x!==a.x||last.y!==a.y) out.push({x:a.x,y:a.y});
      out.push({x:b.x,y:b.y});
      prevDelta={dx:0,dy:0};
      continue;
    }

    const orient=isH?'H':'V';
    const coord=isH?a.y:b.x;
    const lane=laneIndexFor(net,orient,coord);
    const delta=isH?{dx:0,dy:lane*spacing}:{dx:lane*spacing,dy:0};
    const aOff={x:a.x+delta.dx,y:a.y+delta.dy};
    const bOff={x:b.x+delta.dx,y:b.y+delta.dy};
    const last=out[out.length-1];
    const isFirst = (i===0);
    const isLastSeg = (i===segCount-1);

    if(isFirst){
      if(last.x!==a.x||last.y!==a.y) out.push({x:a.x,y:a.y});
      if(a.x!==b.x||a.y!==b.y) out.push({x:b.x,y:b.y});
      if(isH){ if(bOff.y!==b.y) out.push({x:b.x,y:bOff.y}); }
      else   { if(bOff.x!==b.x) out.push({x:bOff.x,y:b.y}); }
      prevDelta=delta;
      continue;
    }

    if(last.x!==aOff.x || last.y!==aOff.y){
      if(prevDelta.dx!==delta.dx || prevDelta.dy!==delta.dy){
        const corner=isH?{x:a.x+prevDelta.dx,y:a.y+delta.dy}:{x:a.x+delta.dx,y:a.y+prevDelta.dy};
        if(corner.x!==last.x||corner.y!==last.y) out.push(corner);
      }
      out.push(aOff);
    }
    out.push(bOff);
    prevDelta=delta;

    if(isLastSeg){
      if(isH){ if(bOff.y!==b.y) out.push({x:b.x,y:b.y}); }
      else   { if(bOff.x!==b.x) out.push({x:b.x,y:b.y}); }
    }
  }
  return simplifyPath(out);
}

export function getPinExtension(pin){
  const inst=pin.inst;
  const L=(inst && (detectType(inst)==='MCU'||detectType(inst)==='IC'))?ROUTE_STUB_IC:ROUTE_STUB;
  if(!inst) return {x:snap(pin.x),y:snap(pin.y)};
  
  const side = sideOfPinOnInst(inst, pin);
  if(side==='left')   return {x:snap(pin.x-L),y:pin.y};
  if(side==='right')  return {x:snap(pin.x+L),y:pin.y};
  if(side==='top')    return {x:pin.x,y:snap(pin.y-L)};
  return {x:pin.x,y:snap(pin.y+L)};
}

function hash32(s){ 
  let h=2166136261>>>0; 
  for(let i=0;i<s.length;i++){ 
    h^=s.charCodeAt(i); 
    h=Math.imul(h,16777619); 
  } 
  return h>>>0; 
}

export function getNetStyle(net){
  const name=String(net||'').trim(); 
  if(App.netStyles.has(name)) return App.netStyles.get(name);
  let stroke='#222', dash='', width=WIRE_WIDTH;
  if(isPowerName(name)) stroke=getComputedStyle(document.documentElement).getPropertyValue('--vcc').trim() || '#ef4444';
  else if(isGndName(name)) stroke=getComputedStyle(document.documentElement).getPropertyValue('--gnd').trim() || '#0ea5e9';
  else{
    const h=hash32(name)%360, s=60+(hash32(name+'s')%25), l=32+(hash32(name+'l')%18);
    stroke=`hsl(${h} ${s}% ${l}%)`;
    dash='';
  }
  const st={stroke,dash,width};
  App.netStyles.set(name,st); 
  return st;
}

function laneIndexFor(net,orient,coord){
  const key=orient+'@'+Math.round(coord);
  let m=App.segmentLanes.get(key);
  if(!m){ 
    m=new Map(); 
    App.segmentLanes.set(key,m); 
  }
  if(!m.has(net)){
    const used=new Set(m.values());
    let idx=0;
    for(let step=0; step<=LANE_MAX; step++){
      const a= step, b= -step;
      if(!used.has(a)){ idx=a; break; }
      if(!used.has(b)){ idx=b; break; }
    }
    m.set(net,idx);
  }
  return m.get(net);
}

// --- 路径搜索算法 ---
export function tryStraightPath(start, end, obstacles, excludeInsts) {
  const s = {x: snap(start.x), y: snap(start.y)};
  const e = {x: snap(end.x), y: snap(end.y)};
  if (s.x !== e.x && s.y !== e.y) return null;

  const path = [s, e];
  if (!pathHitsObstacle(path, obstacles, excludeInsts)) {
    return path;
  }
  return null;
}

export function tryLPath(start,end,obstacles,excludeInsts,preferAxis){
  const s={x:snap(start.x),y:snap(start.y)}, e={x:snap(end.x),y:snap(end.y)};
  const mids=[{x:e.x,y:s.y},{x:s.x,y:e.y}];
  const order=(preferAxis==='h')?[0,1]:(preferAxis==='v')?[1,0]:[0,1];
  for(const idx of order){
    const mid=mids[idx]; 
    const path=[s,mid,e];
    if(!pathHitsObstacle(path,obstacles,excludeInsts)) return path;
  }
  return null;
}

export function tryZPath(start, end, obstacles, excludeInsts) {
  const s = { x: snap(start.x), y: snap(start.y) };
  const e = { x: snap(end.x), y: snap(end.y) };

  const midX = snap(s.x + (e.x - s.x) / 2);
  const p1_hvh = { x: midX, y: s.y };
  const p2_hvh = { x: midX, y: e.y };
  const pathHVH = [s, p1_hvh, p2_hvh, e];
  if (!pathHitsObstacle(pathHVH, obstacles, excludeInsts)) {
    return pathHVH;
  }

  const midY = snap(s.y + (e.y - s.y) / 2);
  const p1_vhv = { x: s.x, y: midY };
  const p2_vhv = { x: e.x, y: midY };
  const pathVHV = [s, p1_vhv, p2_vhv, e];
  if (!pathHitsObstacle(pathVHV, obstacles, excludeInsts)) {
    return pathVHV;
  }

  return null;
}

function aStarRoute(start, end, obstacles, excludeInsts, startNodeInfo = null) {
    const sx = snap(start.x), sy = snap(start.y), ex = snap(end.x), ey = snap(end.y);
    const startDir = startNodeInfo ? startNodeInfo.dir : null;
    const openSet = [{ f: 0, g: 0, x: sx, y: sy, parent: null, dir: startDir }];
    const closedSet = new Set();
    const startTime = performance.now();
    let iter = 0;
    const manhattan = (x, y) => Math.abs(x - ex) + Math.abs(y - ey);

    while (openSet.length > 0) {
        if (iter++ > 60000 || performance.now() - startTime > 600) return null;
        openSet.sort((a, b) => a.f - b.f);
        const current = openSet.shift();
        const currentKey = `${current.x},${current.y}`;
        if (current.x === ex && current.y === ey) {
            const path = [];
            let temp = current;
            while (temp) {
                path.unshift({ x: temp.x, y: temp.y });
                temp = temp.parent;
            }
            return path;
        }
        closedSet.add(currentKey);

        // Enforce orthogonality: only H/V directions
        const dirs = [
            { dx: GRID, dy: 0, name: 'H' },
            { dx: -GRID, dy: 0, name: 'H' },
            { dx: 0, dy: GRID, name: 'V' },
            { dx: 0, dy: -GRID, name: 'V' }
        ];

        for (const dir of dirs) {
            const nx = current.x + dir.dx, ny = current.y + dir.dy, neighborKey = `${nx},${ny}`;
            if (nx < 0 || ny < 0 || nx > DEFAULT_VB.w || ny > DEFAULT_VB.h || closedSet.has(neighborKey)) continue;

            // Check obstacles (existing)
            let blocked = false;
            for (const obs of obstacles) {
                if (excludeInsts.includes(obs.inst)) continue;
                if (pointInRect(nx, ny, obs) || segIntersectsRect({ x: current.x, y: current.y }, { x: nx, y: ny }, obs)) {
                    blocked = true;
                    break;
                }
            }
            if (blocked) continue;

            // Direction inheritance and penalties
            const isTurn = (current.dir && current.dir !== dir.name);
            const backwardsPenalty = manhattan(nx, ny) > manhattan(current.x, current.y) ? BACKWARDS_PENALTY : 0;
            const aestheticPenalty = isTurn ? TURN_PENALTY * 2 : 0;  // Double penalty for turns to favor straight lines
            const tentativeGScore = current.g + GRID + aestheticPenalty + backwardsPenalty;

            let neighbor = openSet.find(node => node.x === nx && node.y === ny);
            if (!neighbor) {
                neighbor = {
                    g: tentativeGScore,
                    h: manhattan(nx, ny),
                    f: tentativeGScore + manhattan(nx, ny),
                    x: nx,
                    y: ny,
                    parent: current,
                    dir: dir.name
                };
                openSet.push(neighbor);
            } else if (tentativeGScore < neighbor.g) {
                neighbor.g = tentativeGScore;
                neighbor.f = tentativeGScore + neighbor.h;
                neighbor.parent = current;
                neighbor.dir = dir.name;
            }
        }
    }
    return null;
}

function postProcessPath(path, obstacles, excludeInsts) {
    if (!path || path.length <= 2) return path;
    const newPath = [path[0]];
    let currentIdx = 0;
    while (currentIdx < path.length - 1) {
        let bestNextIdx = -1;
        for (let i = path.length - 1; i > currentIdx; i--) {
            const startNode = path[currentIdx];
            const endNode = path[i];
            const simplePath = tryStraightPath(startNode, endNode, obstacles, excludeInsts) ||
                            tryLPath(startNode, endNode, obstacles, excludeInsts, 'h') ||
                            tryLPath(startNode, endNode, obstacles, excludeInsts, 'v');
            
            if (simplePath) {
                bestNextIdx = i;
                break;
            }
        }
        
        if (bestNextIdx !== -1) {
            const startNode = path[currentIdx];
            const endNode = path[bestNextIdx];
            const simplifiedSegment = tryStraightPath(startNode, endNode, obstacles, excludeInsts) ||
                                    tryLPath(startNode, endNode, obstacles, excludeInsts, 'h') ||
                                    tryLPath(startNode, endNode, obstacles, excludeInsts, 'v');

            for(let j = 1; j < simplifiedSegment.length; j++) {
                newPath.push(simplifiedSegment[j]);
            }
            currentIdx = bestNextIdx;
        } else {
            currentIdx++;
            newPath.push(path[currentIdx]);
        }
    }
    // 新增：检查总线对齐/合并（移到末尾）
    const alignedPath = alignPathToBus(path);
    return alignedPath || simplifyPath(newPath);  // 如果可能，使用对齐后的路径
}

// 添加：在postProcessPath函数后立即添加此独立函数（完善占位实现）
function alignPathToBus(path) {
    // 实现示例：假设从App.layoutPlan.busAwareGroups获取总线，检查路径是否靠近（距离<20px）
    const engine = App.currentPlacementEngine;
    if (!engine || !engine.layoutPlan.busAwareGroups) return null;

    for (const busGroup of engine.layoutPlan.busAwareGroups) {
        // 假设busGroup有path属性（您需要在布局中添加），检查path是否可snap
        const busPath = busGroup.path;  // 假设存在
        if (!busPath) continue;

        // 简单检查：如果path起点/终点靠近busPath，调整为snap
        const threshold = 20;
        if (Math.hypot(path[0].x - busPath[0].x, path[0].y - busPath[0].y) < threshold) {
            // 调整path snap到总线
            const snappedPath = [...path];
            snappedPath[0] = busPath[0];  // 示例snap
            return snappedPath;
        }
    }
    return null;  // 无对齐，返回null
}

function routeConnection(pinA, pinB, obstacles) {
  const excludeInsts = [pinA.inst, pinB.inst].filter(Boolean);
  const stubA = getPinExtension(pinA), stubB = getPinExtension(pinB);
  const sideA = pinA.inst ? sideOfPinOnInst(pinA.inst, pinA) : 'left';
  const preferAxis = (sideA === 'left' || sideA === 'right') ? 'h' : 'v';
  
  let core = tryStraightPath(stubA, stubB, obstacles, excludeInsts) 
          || tryLPath(stubA, stubB, obstacles, excludeInsts, preferAxis)
          || tryZPath(stubA, stubB, obstacles, excludeInsts);

  if (!core) {
    const startInfo = { dir: (sideA === 'left' || sideA === 'right') ? 'H' : 'V' };
    core = aStarRoute(stubA, stubB, obstacles, excludeInsts, startInfo);
    if (core) {
      core = postProcessPath(core, obstacles, excludeInsts);
    }
  }
  
  if (!core) return null;

  const full = [{ x: pinA.x, y: pinA.y }];
  full.push(stubA);
  full.push(...core);
  full.push(stubB);
  full.push({ x: pinB.x, y: pinB.y });

  return simplifyPath(full);
}

// --- 布线策略 ---
function median(arr){ 
  const a=[...arr].sort((x,y)=>x-y); 
  const n=a.length; 
  if(!n) return 0; 
  return a[Math.floor((n-1)/2)]; 
}

function rangeMin(arr){ return Math.min(...arr); }
function rangeMax(arr){ return Math.max(...arr); }

function scanTrunkCoord(orient,candidate,span1,span2,stubs,obstacles){
  const order=[]; 
  for(let k=0;k<=TRUNK_SCAN_STEPS;k++){ 
    order.push(k*GRID,-k*GRID); 
  }
  for(const off of order){
    const coord=snap(candidate+off);
    if(orient==='V'){
      if(lineHitsObstacles({x:coord,y:span1-1},{x:coord,y:span2+1},obstacles)) continue;
      let ok=true;
      for(const s of stubs){
        const a={x:s.stub.x,y:s.stub.y}, b={x:coord,y:s.stub.y};
        if(lineHitsObstacles(a,b,obstacles,[s.n.inst])){ 
          ok=false; 
          break; 
        }
      }
      if(ok) return coord;
    }else{
      if(lineHitsObstacles({x:span1-1,y:coord},{x:span2+1,y:coord},obstacles)) continue;
      let ok=true;
      for(const s of stubs){
        const a={x:s.stub.x,y:s.stub.y}, b={x:s.stub.x,y:coord};
        if(lineHitsObstacles(a,b,obstacles,[s.n.inst])){ 
          ok=false; 
          break; 
        }
      }
      if(ok) return coord;
    }
  }
  return null;
}

function routeNetAsTrunk(netName, nodes, obstacles, customLaneSpacing){
  const stubs=nodes.map(n=>({ 
    n, 
    side: n.inst ? sideOfPinOnInst(n.inst,n) : 'left', 
    stub: getPinExtension(n) 
  }));

  const instsInNet = [...new Set(nodes.map(n => n.inst).filter(Boolean))];
  const xs=instsInNet.map(i=>i.x), ys=instsInNet.map(i=>i.y);
  const spanX=rangeMax(xs)-rangeMin(xs), spanY=rangeMax(ys)-rangeMin(ys);
  const orient = (spanY >= spanX * 1.2) ? 'V' : 'H';
  const spacing = customLaneSpacing !== undefined ? customLaneSpacing : LANE_SPACING;

  let candidateCoord;

  if (orient === 'V') {
    const centerX = xs.reduce((a,b)=>a+b,0) / xs.length;
    const leftGroup = instsInNet.filter(i => (i.x + effSize(i).w/2) < centerX);
    const rightGroup = instsInNet.filter(i => (i.x + effSize(i).w/2) >= centerX);

    if (leftGroup.length > 0 && rightGroup.length > 0) {
      const leftEdge = Math.max(...leftGroup.map(i => i.x + effSize(i).w));
      const rightEdge = Math.min(...rightGroup.map(i => i.x));
      candidateCoord = leftEdge + (rightEdge - leftEdge) / 2;
    } else {
      candidateCoord = median(stubs.map(s => s.stub.x));
    }
    
    const y1=snap(rangeMin(stubs.map(s=>s.stub.y)));
    const y2=snap(rangeMax(stubs.map(s=>s.stub.y)));
    const baseTrunkX=scanTrunkCoord('V',candidateCoord,y1,y2,stubs,obstacles);
    if(baseTrunkX==null) return { success: false };

    const lane = laneIndexFor(netName, 'V', baseTrunkX);
    const offset = lane * spacing;
    const finalTrunkX = baseTrunkX + offset;

    const trunkPath = [{x:finalTrunkX,y:y1},{x:finalTrunkX,y:y2}];
    drawDirectWire(trunkPath, netName);
    addWireToObstacles(trunkPath, obstacles);
    
    const atts=[];
    for(const s of stubs){
      const a={x:s.n.x,y:s.n.y}, b=s.stub;
      const c={x:finalTrunkX,y:b.y};
      const stubPath = simplifyPath([a,b,c]);
      drawDirectWire(stubPath, netName);
      addWireToObstacles(stubPath, obstacles);
      atts.push(c);
    }
    drawJunctions(atts);
    drawNetLabel({x:finalTrunkX,y:Math.round((y1+y2)/2)}, netName, 'V', obstacles, nodes[0]);
    return { success: true };
  } else {
    const centerY = ys.reduce((a,b)=>a+b,0) / ys.length;
    const topGroup = instsInNet.filter(i => (i.y + effSize(i).h/2) < centerY);
    const bottomGroup = instsInNet.filter(i => (i.y + effSize(i).h/2) >= centerY);
    
    if (topGroup.length > 0 && bottomGroup.length > 0) {
        const topEdge = Math.max(...topGroup.map(i => i.y + effSize(i).h));
        const bottomEdge = Math.min(...bottomGroup.map(i => i.y));
        candidateCoord = topEdge + (bottomEdge - topEdge) / 2;
    } else {
        candidateCoord = median(stubs.map(s => s.stub.y));
    }

    const x1=snap(rangeMin(stubs.map(s=>s.stub.x)));
    const x2=snap(rangeMax(stubs.map(s=>s.stub.x)));
    const baseTrunkY=scanTrunkCoord('H',candidateCoord,x1,x2,stubs,obstacles);
    if(baseTrunkY==null) return { success: false };

    const lane = laneIndexFor(netName, 'H', baseTrunkY);
    const offset = lane * spacing;
    const finalTrunkY = baseTrunkY + offset;

    const trunkPath = [{x:x1,y:finalTrunkY},{x:x2,y:finalTrunkY}];
    drawDirectWire(trunkPath, netName);
    addWireToObstacles(trunkPath, obstacles);

    const atts=[];
    for(const s of stubs){
      const a={x:s.n.x,y:s.n.y}, b=s.stub;
      const c={x:b.x,y:finalTrunkY};
      const stubPath = simplifyPath([a,b,c]);
      drawDirectWire(stubPath, netName);
      addWireToObstacles(stubPath, obstacles);
      atts.push(c);
    }
    drawJunctions(atts);
    drawNetLabel({x:Math.round((x1+x2)/2),y:finalTrunkY}, netName, 'H', obstacles, nodes[0]);
    return { success: true };
  }
}

function applyLocalTrunks(nodes, netName, obstaclesDyn, customLaneSpacing) {
  const groupsByInst = new Map();
  nodes.forEach(n => {
    if (!n.inst) return;
    const k = n.inst.id;
    if (!groupsByInst.has(k)) groupsByInst.set(k, []);
    groupsByInst.get(k).push(n);
  });

  const processedNodes = new Set();
  const newTrunkNodes = [];
  const spacing = customLaneSpacing !== undefined ? customLaneSpacing : LANE_SPACING;

  for (const [id, arr] of groupsByInst.entries()) {
    const inst = arr[0]?.inst;
    if (!inst) continue;
    
    const sideBuckets = { left: [], right: [], top: [], bottom: [] };
    for (const n of arr) {
      sideBuckets[sideOfPinOnInst(inst, n)].push(n);
    }

    for (const side of ['left', 'right', 'top', 'bottom']) {
      const bucket = sideBuckets[side];
      if (bucket.length < 2) continue;

      bucket.forEach(n => processedNodes.add(n));

      const stubs = bucket.map(n => ({ n, stub: getPinExtension(n) }));
      if (side === 'left' || side === 'right') stubs.sort((a, b) => a.n.y - b.n.y);
      else stubs.sort((a, b) => a.n.x - b.n.x);

      const attachPoints = [];
      
      if (side === 'left' || side === 'right') {
        const ys = stubs.map(s => s.stub.y);
        const y1 = snap(Math.min(...ys)), y2 = snap(Math.max(...ys));
        const xs = stubs.map(s => s.stub.x);
        
        let baseTrunkX = 0;
        const base = side === 'left' ? Math.min(...xs) : Math.max(...xs);
        const dir = side === 'left' ? -1 : 1;
        
        for (let step = 1; step < 10; step++) {
          const tx = snap(base + dir * step * GRID);
          if (!lineHitsObstacles({ x: tx, y: y1 }, { x: tx, y: y2 }, obstaclesDyn, [inst])) {
            baseTrunkX = tx;
            break;
          }
        }
        if (baseTrunkX === 0) baseTrunkX = snap(base + dir * 2 * GRID);
        
        const lane = laneIndexFor(netName, 'V', baseTrunkX);
        const offset = lane * spacing;
        const finalTrunkX = baseTrunkX + offset;

        const finalY1 = Math.min(...stubs.map(s => s.stub.y));
        const finalY2 = Math.max(...stubs.map(s => s.stub.y));
        if (finalY1 < finalY2) {
          const trunkPath = [{ x: finalTrunkX, y: finalY1 }, { x: finalTrunkX, y: finalY2 }];
          drawDirectWire(trunkPath, netName);
          addWireToObstacles(trunkPath, obstaclesDyn);
        }

        stubs.forEach(s => {
          const attach = { x: finalTrunkX, y: s.stub.y };
          attachPoints.push(attach);
          const stubPath = simplifyPath([s.n, s.stub, attach]);
          drawDirectWire(stubPath, netName);
          addWireToObstacles(stubPath, obstaclesDyn);
        });
        drawJunctions(attachPoints);
      } else {
        const xs = stubs.map(s => s.stub.x);
        const x1 = snap(Math.min(...xs)), x2 = snap(Math.max(...xs));
        const ys = stubs.map(s => s.stub.y);
        
        let baseTrunkY = 0;
        const base = side === 'top' ? Math.min(...ys) : Math.max(...ys);
        const dir = side === 'top' ? -1 : 1;

        for (let step = 1; step < 10; step++) {
          const ty = snap(base + dir * step * GRID);
          if (!lineHitsObstacles({ x: x1, y: ty }, { x: x2, y: ty }, obstaclesDyn, [inst])) {
            baseTrunkY = ty;
            break;
          }
        }
        if (baseTrunkY === 0) baseTrunkY = snap(base + dir * 2 * GRID);

        const lane = laneIndexFor(netName, 'H', baseTrunkY);
        const offset = lane * spacing;
        const finalTrunkY = baseTrunkY + offset;

        const finalX1 = Math.min(...stubs.map(s => s.stub.x));
        const finalX2 = Math.max(...stubs.map(s => s.stub.x));
        if (finalX1 < finalX2) {
          const trunkPath = [{ x: finalX1, y: finalTrunkY }, { x: finalX2, y: finalTrunkY }];
          drawDirectWire(trunkPath, netName);
          addWireToObstacles(trunkPath, obstaclesDyn);
        }

        stubs.forEach(s => {
          const attach = { x: s.stub.x, y: finalTrunkY };
          attachPoints.push(attach);
          const stubPath = simplifyPath([s.n, s.stub, attach]);
          drawDirectWire(stubPath, netName);
          addWireToObstacles(stubPath, obstaclesDyn);
        });
        drawJunctions(attachPoints);
      }

      const externalNodes = nodes.filter(n => !bucket.includes(n));
      if (externalNodes.length > 0 && attachPoints.length > 0) {
        let avgX = 0, avgY = 0;
        externalNodes.forEach(n => { avgX += n.x; avgY += n.y; });
        avgX /= externalNodes.length;
        avgY /= externalNodes.length;

        let bestPoint = attachPoints[0];
        let minD2 = (bestPoint.x - avgX) ** 2 + (bestPoint.y - avgY) ** 2;
        for (let i = 1; i < attachPoints.length; i++) {
          const p = attachPoints[i];
          const d2 = (p.x - avgX) ** 2 + (p.y - avgY) ** 2;
          if (d2 < minD2) {
            minD2 = d2;
            bestPoint = p;
          }
        }
        newTrunkNodes.push({ ...bestPoint, inst: null, ref: 'TRUNK', pinNum: null, id: uuid() });
      }
    }
  }

  const remainingNodes = nodes.filter(n => !processedNodes.has(n));
  return { remaining: remainingNodes.concat(newTrunkNodes) };
}

function routeClusterAsBus(cluster, netName, obstacles, customLaneSpacing) {
  if (cluster.length <= 1) {
    return { superNodes: cluster };
  }

  const stubs = cluster.map(n => ({ n, stub: getPinExtension(n) }));
  const xs = stubs.map(s => s.stub.x);
  const ys = stubs.map(s => s.stub.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const avgX = snap(xs.reduce((a, b) => a + b, 0) / xs.length);
  const avgY = snap(ys.reduce((a, b) => a + b, 0) / ys.length);

  const orient = (maxX - minX) > (maxY - minY) ? 'H' : 'V';
  const spacing = customLaneSpacing !== undefined ? customLaneSpacing : LANE_SPACING;
  let superNode;

  if (orient === 'H') {
    let baseTrunkY = scanTrunkCoord('H', avgY, minX - TRUNK_EXTRA, maxX + TRUNK_EXTRA, [], obstacles);
    if (baseTrunkY === null) baseTrunkY = avgY;
    
    const lane = laneIndexFor(netName, 'H', baseTrunkY);
    const offset = lane * spacing;
    const finalTrunkY = baseTrunkY + offset;

    const trunkPath = [{ x: minX, y: finalTrunkY }, { x: maxX, y: finalTrunkY }];
    drawDirectWire(trunkPath, netName);
    addWireToObstacles(trunkPath, obstacles);

    for (const s of stubs) {
      const stubPath = simplifyPath([s.n, s.stub, { x: s.stub.x, y: finalTrunkY }]);
      drawDirectWire(stubPath, netName);
      addWireToObstacles(stubPath, obstacles);
    }
    superNode = { x: snap((minX + maxX) / 2), y: finalTrunkY, inst: null, ref: 'JCT', id: uuid() };
  } else {
    let baseTrunkX = scanTrunkCoord('V', avgX, minY - TRUNK_EXTRA, maxY + TRUNK_EXTRA, [], obstacles);
    if (baseTrunkX === null) baseTrunkX = avgX;

    const lane = laneIndexFor(netName, 'V', baseTrunkX);
    const offset = lane * spacing;
    const finalTrunkX = baseTrunkX + offset;

    const trunkPath = [{ x: finalTrunkX, y: minY }, { x: finalTrunkX, y: maxY }];
    drawDirectWire(trunkPath, netName);
    addWireToObstacles(trunkPath, obstacles);

    for (const s of stubs) {
      const stubPath = simplifyPath([s.n, s.stub, { x: finalTrunkX, y: s.stub.y }]);
      drawDirectWire(stubPath, netName);
      addWireToObstacles(stubPath, obstacles);
    }
    superNode = { x: finalTrunkX, y: snap((minY + maxY) / 2), inst: null, ref: 'JCT', id: uuid() };
  }
  
  return { superNodes: [superNode] };
}

function routeLocalClusters(nodes, netName, obstacles, customLaneSpacing) {
  const clusters = [];
  let remainingNodes = [...nodes];

  while (remainingNodes.length > 0) {
    const currentCluster = [remainingNodes.shift()];
    let searchIndex = 0;
    while (searchIndex < currentCluster.length) {
      const member = currentCluster[searchIndex];
      let i = 0;
      while (i < remainingNodes.length) {
        const candidate = remainingNodes[i];
        const dist = Math.hypot(member.x - candidate.x, member.y - candidate.y);
        if (dist < LOCAL_CLUSTER_RADIUS) {
          currentCluster.push(remainingNodes.splice(i, 1)[0]);
        } else { 
          i++; 
        }
      }
      searchIndex++;
    }
    clusters.push(currentCluster);
  }

  let finalSuperNodes = [];
  for (const cluster of clusters) {
    const result = routeClusterAsBus(cluster, netName, obstacles, customLaneSpacing);
    finalSuperNodes.push(...result.superNodes);
  }
  
  return { remaining: finalSuperNodes };
}

/**
 * 全局布线流程
 */
export function routeAllNets(){

  // 1. 初始化
  $('#g-wires').innerHTML=''; 
  $('#g-junctions').innerHTML=''; 
  $('#g-nettags').innerHTML=''; 
  $('#g-power-symbols').innerHTML='';
  App.wires=[]; 
  App.netLabels=[]; 
  App.powerObstacles=[];
  App.stats={totalNets:0,wiredNets:0,labeledNets:0,optimizedComponents:0,criticalCircuits:0};
  App.segmentLanes=new Map(); 
  App.netStyles=new Map();

  const pinIndex=new Map();
  App.inst.forEach(inst=>inst.pins.forEach(pin=>{ 
    const key=`${inst.ref}.${pin.number}`; 
    const abs=pinAbsCoord(inst,pin); 
    pinIndex.set(key,{...abs, inst, ref:inst.ref, pinNum:pin.number, id:uuid()}); 
  }));

  const baseObstacles=App.inst.map(rectForInstRoute);
  let obstaclesDyn=baseObstacles.slice();

  optimizeAllComponents();

  const nets=(App.plan.nets||[]);
  const powerNets=[], otherNets=[];
  nets.forEach(net=>{ 
    const n=net.name||''; 
    if(isPowerName(n)||isGndName(n)) powerNets.push(net); 
    else otherNets.push(net); 
  });

  // 2. 优先处理重复电路的电源/地总线
  let handledNodeIds = new Set();
  const engine = App.currentPlacementEngine;
  if (engine) {
    const repeatedGroups = engine.layoutPlan?.repeatedGroups || [];
    const busAwareGroups = engine.layoutPlan?.busAwareGroups || [];  // 来自布局
    const allGroups = [...repeatedGroups, ...busAwareGroups];  // 合并
    handledNodeIds = routeRepeatedCircuitsWithBus(allGroups, obstaclesDyn, pinIndex);  // 使用增强函数
}


  // 3. 处理电源网络（会跳过已被总线处理的节点）
  powerNets.forEach(net=>{
    const netName=net.name||''; 
    const isVCC=isPowerName(netName);
    const nodes=[]; 
    (net.nodes||[]).forEach(n=>{ 
      const p=pinIndex.get(`${n.ref}.${n.pin}`); 
      if(p) nodes.push(p); 
    });
    if(!nodes.length) return; 
    App.stats.totalNets++;
    
    let netIsWired = false;
    nodes.forEach(nd=>{
      // 检查此节点是否已被总线逻辑处理过
      if (handledNodeIds.has(nd.id)) {
        netIsWired = true; // 认为它已经被连接了
        return; // 跳过此节点
      }

      const result = placePowerSymbolNearPin(nd,netName,isVCC,obstaclesDyn);
      if(result.success){ 
        netIsWired = true;
      } else { 
        const stub = getPinExtension(nd);
        const wireOrient = (stub.y === nd.y) ? 'H' : 'V';
        drawNetLabel(nd, netName, wireOrient, obstaclesDyn, nd);
      }
    });

    if(netIsWired) {
      App.stats.wiredNets++;
    } else {
      App.stats.labeledNets++;
    }
  });

  // 4. 处理其他信号网络 (这部分代码保持不变)
  otherNets.forEach(net=>{
    const netName=net.name||'';
    const originalNodes=[]; 
    (net.nodes||[]).forEach(n=>{ 
      const p=pinIndex.get(`${n.ref}.${n.pin}`); 
      if(p) originalNodes.push(p); 
    });
    if(!originalNodes.length) return; 
    App.stats.totalNets++;

    let currentLaneSpacing;
    const strategy = $('#routing-strategy').value;

    if (strategy === 'standard') {
        currentLaneSpacing = LANE_SPACING;
    } else if (strategy === 'compact') {
        currentLaneSpacing = LANE_SPACING_TIGHT;
    } else { 
        const netComponents = App.inst.filter(i => originalNodes.some(n => n.ref === i.ref));
        if (netComponents.length > 1) {
            const xs = netComponents.map(i => i.x);
            const ys = netComponents.map(i => i.y);
            const minX = Math.min(...xs), maxX = Math.max(...xs);
            const minY = Math.min(...ys), maxY = Math.max(...ys);
            const diagonal = Math.hypot(maxX - minX, maxY - minY);
            currentLaneSpacing = (diagonal < NET_LOCALITY_THRESHOLD) ? LANE_SPACING_TIGHT : LANE_SPACING;
        } else {
            currentLaneSpacing = LANE_SPACING;
        }
    }

    const res1 = applyLocalTrunks(originalNodes, netName, obstaclesDyn, currentLaneSpacing);
    const res2 = routeLocalClusters(res1.remaining, netName, obstaclesDyn, currentLaneSpacing);
    let nodesForGlobalRoute = res2.remaining;

    if (nodesForGlobalRoute.length <= 1) {
      App.stats.wiredNets++;
    } else {
      const trunkResult = routeNetAsTrunk(netName, nodesForGlobalRoute, obstaclesDyn, currentLaneSpacing);
      if (trunkResult.success) {
        App.stats.wiredNets++;
      } else {
        const components = [];
        let unprocessedNodes = [...nodesForGlobalRoute];
        while (unprocessedNodes.length > 0) {
          const componentSeed = unprocessedNodes.shift();
          const currentComponent = [componentSeed];
          const connected = [componentSeed];
          let remaining = [...unprocessedNodes];
          while (true) {
            let best = { path: null, len: Infinity, idx: -1, srcNode: null, tgtNode: null };
            for (let i = 0; i < remaining.length; i++) {
              for (const src of connected) {
                const path = routeConnection(src, remaining[i], obstaclesDyn);
                if (path) {
                  const len = path.reduce((s, p, idx) => idx ? s + Math.abs(p.x - path[idx - 1].x) + Math.abs(p.y - path[idx - 1].y) : 0, 0);
                  if (len < best.len) best = { path, len, idx: i, srcNode: src, tgtNode: remaining[i] };
                }
              }
            }
            if (best.path && best.len <= MAX_WIRE_LENGTH) {
              const styledPath = drawWire(best.path, netName, currentLaneSpacing);
              addWireToObstacles(styledPath, obstaclesDyn);
              const newNode = remaining.splice(best.idx, 1)[0];
              connected.push(newNode);
              currentComponent.push(newNode);
            } else break;
          }
          unprocessedNodes = remaining;
          components.push(currentComponent);
        }
        
        if (components.length > 1) {
          App.stats.labeledNets++;
          components.forEach(comp => {
            if (comp.length > 0) {
              const labelNode = comp[0];
              const stub = getPinExtension(labelNode);
              const wireOrient = (stub.y === labelNode.y) ? 'H' : 'V';
              const suppressJunction = (comp.length === 1);
              drawNetLabel(labelNode, netName, wireOrient, obstaclesDyn, labelNode, suppressJunction);
            }
          });
        } else {
          App.stats.wiredNets++;
        }
        
        const nodeSet = new Set();
        for(const comp of components) {
          for(const node of comp) {
            nodeSet.add(node);
          }
        }
        drawJunctions([...nodeSet]);
      }
    }
  });

  // 5. 更新UI统计信息
  $('#wire-count').textContent=App.wires.length;
  $('#label-count').textContent=App.netLabels.length;
  $('#critical-count').textContent=String(App.stats.criticalCircuits);
  const successRate=App.stats.totalNets>0? Math.round((App.stats.wiredNets)/App.stats.totalNets*100)+'%' : '--';
  $('#success-rate').textContent=successRate;
  


}