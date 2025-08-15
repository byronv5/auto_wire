import { GRID, Params, snap } from './state.js';

export function effSize(inst) {
	const w = inst.symbol.w || 120, h = inst.symbol.h || 60;
	if ((inst.rot % 180 + 180) % 180 === 0) return { w, h };
	return { w: h, h: w };
}

export function localToEffForAngle(inst, x, y, angle) {
	angle = ((angle % 360) + 360) % 360;
	const w = inst.symbol.w || 120, h = inst.symbol.h || 60;
	if (angle === 0) return { x, y };
	if (angle === 90) return { x: h - y, y: x };
	if (angle === 180) return { x: w - x, y: h - y };
	if (angle === 270) return { x: y, y: w - x };
	return { x, y };
}

export function localToEff(inst, x, y) {
	return localToEffForAngle(inst, x, y, inst.rot || 0);
}

export function pinAbsCoord(inst, pin) {
	const a = localToEff(inst, pin.x, pin.y);
	return { x: inst.x + a.x, y: inst.y + a.y };
}

export function instTransform(inst) {
	const a = ((inst.rot || 0) % 360 + 360) % 360;
	const w = inst.symbol.w || 120, h = inst.symbol.h || 60;
	if (a === 0) return `translate(${inst.x},${inst.y})`;
	if (a === 90) return `translate(${inst.x + h},${inst.y}) rotate(90)`;
	if (a === 180) return `translate(${inst.x + w},${inst.y + h}) rotate(180)`;
	if (a === 270) return `translate(${inst.x},${inst.y + w}) rotate(270)`;
	return `translate(${inst.x},${inst.y})`;
}

export function pinAbsByNumber(inst, num) {
	if (!inst || !Array.isArray(inst.pins)) return null;
	const p = inst.pins.find(pp => String(pp.number) === String(num));
	if (!p) return null;
	const a = pinAbsCoord(inst, p);
	return { x: a.x, y: a.y };
}

export function sideOfPinOnInst(inst, absPt) {
	const s = effSize(inst);
	const rx = absPt.x - inst.x, ry = absPt.y - inst.y;
	
	// 使用相对位置判断，基于器件尺寸的比例
	const leftThreshold = s.w * 0.3;   // 左侧30%区域
	const rightThreshold = s.w * 0.7;  // 右侧30%区域  
	const topThreshold = s.h * 0.3;    // 顶部30%区域
	const bottomThreshold = s.h * 0.7; // 底部30%区域
	
	// 优先判断左右，再判断上下
	if (rx < leftThreshold) {
		return 'left';
	}
	if (rx > rightThreshold) {
		return 'right';
	}
	if (ry < topThreshold) {
		return 'top';
	}
	return 'bottom';
}

export function rectsOverlap(a, b) {
	return !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y);
}

export function inflateRect(r, m) {
	return { ...r, x: r.x - m, y: r.y - m, w: r.w + 2 * m, h: r.h + 2 * m };
}

export function rectForInst(inst) {
	const s = effSize(inst);
	return { x: inst.x, y: inst.y, w: s.w, h: s.h, inst };
}

export function rectForInstRoute(inst) {
	const base = rectForInst(inst);
	const inf = inflateRect(base, Params.clear);
	inf.inst = inst;
	return inf;
}

export function simplifyPath(path) {
	if (!path || path.length < 3) return path;
	const out = [path[0]];
	for (let i = 1; i < path.length - 1; i++) {
		const a = out[out.length - 1], b = path[i], c = path[i + 1];
		const dx1 = b.x - a.x, dy1 = b.y - a.y, dx2 = c.x - b.x, dy2 = c.y - b.y;
		if (!((dx1 === 0 && dx2 === 0) || (dy1 === 0 && dy2 === 0))) out.push(b);
	}
	out.push(path[path.length - 1]);
	return out;
}

export function segIntersectsRect(a, b, r) {
	if (a.x === b.x) {
		const x = a.x, y1 = Math.min(a.y, b.y), y2 = Math.max(a.y, b.y);
		if (x < r.x || x > r.x + r.w) return false;
		return !(y2 <= r.y || y1 >= r.y + r.h);
	}
	if (a.y === b.y) {
		const y = a.y, x1 = Math.min(a.x, b.x), x2 = Math.max(a.x, b.x);
		if (y < r.y || y > r.y + r.h) return false;
		return !(x2 <= r.x || x1 >= r.x + r.w);
	}
	return false;
}

export function segToRect(a, b, inflate = 0) {
	if (a.x === b.x) {
		const x = a.x - inflate;
		const y = Math.min(a.y, b.y) - inflate;
		const w = inflate * 2;
		const h = Math.abs(a.y - b.y) + inflate * 2;
		return { x, y, w, h };
	} else {
		const x = Math.min(a.x, b.x) - inflate;
		const y = a.y - inflate;
		const w = Math.abs(a.x - b.x) + inflate * 2;
		const h = inflate * 2;
		return { x, y, w, h };
	}
}

export const manhattan = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

export const nextFrame = () => new Promise(r => requestAnimationFrame(r));


