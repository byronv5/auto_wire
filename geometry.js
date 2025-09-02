import { AVOID_CLEARANCE, ROUTE_CLEARANCE, WIRE_OBSTACLE_WIDTH } from './config.js';
import { effSize } from './component.js';

/* ===== 几何/避障 ===== */
export function rectForInst(inst){ 
  const s=effSize(inst); 
  return {
    x:inst.x-AVOID_CLEARANCE,
    y:inst.y-AVOID_CLEARANCE,
    w:s.w+2*AVOID_CLEARANCE,
    h:s.h+2*AVOID_CLEARANCE,
    inst
  }; 
}

export function rectForInstRoute(inst){ 
  const base=rectForInst(inst); 
  const inf={
    ...base,
    x:base.x-ROUTE_CLEARANCE,
    y:base.y-ROUTE_CLEARANCE,
    w:base.w+2*ROUTE_CLEARANCE,
    h:base.h+2*ROUTE_CLEARANCE
  }; 
  inf.inst=inst; 
  return inf; 
}

export function pointInRect(x,y,r){ 
  return (x>r.x && x<r.x+r.w && y>r.y && y<r.y+r.h); 
}

export function segIntersectsRect(a,b,r){
  if(a.x===b.x){ 
    const x=a.x, y1=Math.min(a.y,b.y), y2=Math.max(a.y,b.y); 
    if(x<=r.x||x>=r.x+r.w) return false; 
    return !(y2<=r.y || y1>=r.y+r.h); 
  }
  if(a.y===b.y){ 
    const y=a.y, x1=Math.min(a.x,b.x), x2=Math.max(a.x,b.x); 
    if(y<=r.y||y>=r.y+r.h) return false; 
    return !(x2<=r.x || x1>=r.x+r.w); 
  }
  return false;
}

export function lineHitsObstacles(a,b,obs,exclude=[]){ 
  for(const o of obs){ 
    if(exclude.includes(o.inst)) continue; 
    if(segIntersectsRect(a,b,o)) return true; 
  } 
  return false; 
}

export function pathHitsObstacle(pts,obstacles,excludeInsts=[]){ 
  for(let i=0;i<pts.length-1;i++){ 
    if(lineHitsObstacles(pts[i],pts[i+1],obstacles,excludeInsts)) return true; 
  } 
  return false; 
}

export function rectsOverlap(a,b){ 
  return !(a.x+a.w<=b.x || b.x+b.w<=a.x || a.y+a.h<=b.y || b.y+b.h<=a.y); 
}

export function addWireToObstacles(path, obstacles) {
  if (!path || path.length < 2) return;
  for (let i = 0; i < path.length - 1; i++) {
    const p1 = path[i];
    const p2 = path[i+1];
    let x, y, w, h;
    if (p1.x === p2.x) { // Vertical segment
      x = p1.x - WIRE_OBSTACLE_WIDTH / 2;
      y = Math.min(p1.y, p2.y) - WIRE_OBSTACLE_WIDTH / 2;
      w = WIRE_OBSTACLE_WIDTH;
      h = Math.abs(p1.y - p2.y) + WIRE_OBSTACLE_WIDTH;
    } else { // Horizontal segment
      x = Math.min(p1.x, p2.x) - WIRE_OBSTACLE_WIDTH / 2;
      y = p1.y - WIRE_OBSTACLE_WIDTH / 2;
      w = Math.abs(p1.x - p2.x) + WIRE_OBSTACLE_WIDTH;
      h = WIRE_OBSTACLE_WIDTH;
    }
    obstacles.push({ x, y, w, h, inst: null, type: 'wire' });
  }
}