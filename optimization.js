import { App } from './state.js';
import { toast } from './utils.js';
import { renderInstances, detectType, effSize, pinAbsCoord, pinAbsByNumber } from './component.js';
import { getPinExtension, tryStraightPath, tryLPath, tryZPath } from './routing.js';
import { rectForInstRoute } from './geometry.js';

/* ===== 智能旋转优化 ===== */

function isTwoPinPassive(inst) {
  const type = detectType(inst);
  return ['Resistor', 'Capacitor', 'Inductor', 'Diode', 'Crystal'].includes(type) && inst.pins.length === 2;
}

function findConnectedEndpoints(inst) {
  if (!inst.pins || inst.pins.length !== 2) return null;
  const pin1 = inst.pins[0];
  const pin2 = inst.pins[1];
  const endpoints = { pin1: null, pin2: null };

  for (const net of App.plan.nets || []) {
    const nodes = net.nodes || [];
    let nodeOnInst = null;
    let otherNode = null;
    
    // 检查此网络是否连接到 pin1
    nodeOnInst = nodes.find(n => n.ref === inst.ref && String(n.pin) === String(pin1.number));
    if (nodeOnInst) {
      otherNode = nodes.find(n => n.ref !== inst.ref);
      if (otherNode) {
        const otherInst = App.byRef.get(otherNode.ref);
        if (otherInst) {
          const pt = pinAbsByNumber(otherInst, otherNode.pin);
          if (pt) endpoints.pin1 = { ...pt, inst: otherInst };
        }
      }
    }
    
    // 检查此网络是否连接到 pin2
    nodeOnInst = nodes.find(n => n.ref === inst.ref && String(n.pin) === String(pin2.number));
    if (nodeOnInst) {
      otherNode = nodes.find(n => n.ref !== inst.ref);
      if (otherNode) {
        const otherInst = App.byRef.get(otherNode.ref);
        if (otherInst) {
          const pt = pinAbsByNumber(otherInst, otherNode.pin);
          if (pt) endpoints.pin2 = { ...pt, inst: otherInst };
        }
      }
    }
  }
  return (endpoints.pin1 && endpoints.pin2) ? endpoints : null;
}

function calculatePathLengthForRotation(inst, rotation, endpoints, obstacles) {
  const originalRot = inst.rot;
  inst.rot = rotation; // 临时应用旋转
  
  const pin1Abs = pinAbsCoord(inst, inst.pins[0]);
  const pin2Abs = pinAbsCoord(inst, inst.pins[1]);
  const excludeInsts = [inst, endpoints.pin1.inst, endpoints.pin2.inst].filter(Boolean);
  const stub1 = getPinExtension({ ...pin1Abs, inst });
  const stub2 = getPinExtension({ ...pin2Abs, inst });
  const stubEnd1 = getPinExtension(endpoints.pin1);
  const stubEnd2 = getPinExtension(endpoints.pin2);
  
  let path1 = tryStraightPath(stub1, stubEnd1, obstacles, excludeInsts) 
           || tryLPath(stub1, stubEnd1, obstacles, excludeInsts, 'h')
           || tryZPath(stub1, stubEnd1, obstacles, excludeInsts);
  let path2 = tryStraightPath(stub2, stubEnd2, obstacles, excludeInsts) 
           || tryLPath(stub2, stubEnd2, obstacles, excludeInsts, 'h')
           || tryZPath(stub2, stubEnd2, obstacles, excludeInsts);
           
  inst.rot = originalRot; // 恢复原始旋转
  
  if (!path1 || !path2) return Infinity;
  
  const calcLength = (path) => path.reduce((len, p, i) => i ? len + Math.abs(p.x - path[i-1].x) + Math.abs(p.y - path[i-1].y) : 0, 0);
  
  return calcLength(path1) + calcLength(path2);
}

// [FIXED] Added the missing function definition
function optimizeComponentRotation(inst, obstacles) {
  if (!isTwoPinPassive(inst)) {
    return false;
  }

  const endpoints = findConnectedEndpoints(inst);
  if (!endpoints) {
    return false;
  }

  const rotations = [0, 90];
  let bestRotation = inst.rot;
  let minLength = calculatePathLengthForRotation(inst, inst.rot, endpoints, obstacles);

  for (const rot of rotations) {
    if (rot === inst.rot) continue;
    const length = calculatePathLengthForRotation(inst, rot, endpoints, obstacles);
    if (length < minLength) {
      minLength = length;
      bestRotation = rot;
    }
  }

  if (bestRotation !== inst.rot) {
    inst.rot = bestRotation;
    return true; // 优化成功
  }

  return false; // 无需优化
}


export function optimizeAllComponents() {
  if (!App.byRef) {
    App.byRef = new Map(App.inst.map(i => [i.ref, i]));
  }
  const obstacles = App.inst.map(rectForInstRoute);
  let optimizedCount = 0;
  for (const inst of App.inst) {
    if (optimizeComponentRotation(inst, obstacles)) {
      optimizedCount++;
    }
  }
  App.stats.optimizedComponents = optimizedCount;
  document.getElementById('optimization-count').textContent = String(optimizedCount);
  if (optimizedCount > 0) {
    renderInstances();
    toast(`优化了 ${optimizedCount} 个器件的旋转角度`, 'ok');
  }
  return optimizedCount;
}