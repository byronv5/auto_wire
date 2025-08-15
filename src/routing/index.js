import { App, $, GRID, Params, WIRE_WIDTH, POWER_LEAD, POWER_TRI_W, POWER_TRI_H, GND_W, GND_H, toast, snap } from '../state.js';
import { effSize, inflateRect, rectForInstRoute, pinAbsByNumber, sideOfPinOnInst, segIntersectsRect, segToRect, simplifyPath, manhattan, nextFrame } from '../geometry.js';
import { isPowerName } from '../types.js';

class SpatialIndex {
	constructor(cell = 64) { this.cell = cell; this.map = new Map(); }
	_key(i, j) { return i + ',' + j; }
	_range(a, b, sz) { return [Math.floor(a / sz), Math.floor(b / sz)]; }
	addRect(r, data = null) {
		const x1 = r.x, y1 = r.y, x2 = r.x + r.w, y2 = r.y + r.h;
		const [i1, i2] = this._range(Math.min(x1, x2), Math.max(x1, x2), this.cell);
		const [j1, j2] = this._range(Math.min(y1, y2), Math.max(y1, y2), this.cell);
		for (let i = i1; i <= i2; i++) for (let j = j1; j <= j2; j++) {
			const k = this._key(i, j);
			if (!this.map.has(k)) this.map.set(k, []);
			this.map.get(k).push({ ...r, data });
		}
	}
	queryRect(r) {
		const out = [], seen = new Set();
		const x1 = r.x, y1 = r.y, x2 = r.x + r.w, y2 = r.y + r.h;
		const [i1, i2] = this._range(Math.min(x1, x2), Math.max(x1, x2), this.cell);
		const [j1, j2] = this._range(Math.min(y1, y2), Math.max(y1, y2), this.cell);
		for (let i = i1; i <= i2; i++) for (let j = j1; j <= j2; j++) {
			const arr = this.map.get(this._key(i, j)); if (!arr) continue;
			for (const it of arr) {
				const id = it.__id || it; if (seen.has(id)) continue;
				if (!(it.x + it.w <= r.x || r.x + r.w <= it.x || it.y + it.h <= r.y || r.y + r.h <= it.y)) { seen.add(id); out.push(it); }
			}
		}
		return out;
	}
}

function hitsHardSegment(a, b, hardIndex, excludeInstsSet) {
	const rect = inflateRect(segToRect(a, b, 0), 1);
	const candidates = hardIndex.queryRect(rect);
	for (const o of candidates) {
		const inst = o.data && o.data.inst;
		if (inst && excludeInstsSet && excludeInstsSet.has(inst)) continue;
		if (segIntersectsRect(a, b, o)) return true;
	}
	return false;
}

function softCostForStepIndexed(p, n, softIndex, netName, nearInflate, weights) {
	let cross = 0, near = 0;
	const stepRect = segToRect(p, n, 0);
	const nearRect = inflateRect(stepRect, nearInflate);
	const candidates = softIndex.queryRect(nearRect);
	for (const so of candidates) {
		const soNet = so.data && so.data.net;
		if (segIntersectsRect(p, n, so)) cross += (soNet === netName ? weights.crossSameNet : weights.crossWire);
		else near += weights.nearWire;
	}
	return cross + near;
}

class MinHeap {
	constructor() { this.a = []; }
	push(n) { this.a.push(n); this.up(this.a.length - 1); }
	up(i) { const a = this.a; while (i > 0) { const p = (i - 1) >> 1; if (a[p].f <= a[i].f) break; [a[p], a[i]] = [a[i], a[p]]; i = p; } }
	pop() { if (!this.a.length) return null; const t = this.a[0]; const last = this.a.pop(); if (this.a.length) { this.a[0] = last; this.down(0); } return t; }
	down(i) { const a = this.a; const n = a.length; while (true) { let l = i*2+1, r = l+1, s = i; if (l<n && a[l].f<a[s].f) s=l; if (r<n && a[r].f<a[s].f) s=r; if (s===i) break; [a[s], a[i]] = [a[i], a[s]]; i=s; } }
	get size() { return this.a.length; }
}

const dirOfStep = (from, to) => (to.x > from.x ? 0 : to.x < from.x ? 1 : to.y > from.y ? 2 : 3);
const isHoriz = dir => dir === 0 || dir === 1;

function findPathAStar(start, end, ctx) {
	const t0 = performance.now();
	const timeLimit = Math.min(ctx.timeLimitMs ?? 120, Params.time);
	const visitLimit = Math.min(ctx.visitLimit ?? 60000, Params.visits);
	const open = new MinHeap();
	const key = (x, y, dir) => `${x},${y},${dir}`;
	const startDir = -1;
    const h0 = manhattan(start, end) / GRID;
	open.push({ x: start.x, y: start.y, g: 0, h: h0, f: h0, dir: startDir, prev: null });
	const best = new Map();
	best.set(key(start.x, start.y, startDir), 0);
	let visits = 0;
	while (open.size) {
		if (ctx.abort && ctx.abort()) return null;
		if (performance.now() - t0 > timeLimit || visits > visitLimit) return null;
		const cur = open.pop();
		visits++;
		if (cur.x === end.x && cur.y === end.y) {
			const path = [];
			let c = cur; while (c) { path.push({ x: c.x, y: c.y }); c = c.prev; }
			path.reverse();
			return simplifyPath(path);
		}
        const neighbors = [
            { x: cur.x + GRID, y: cur.y }, { x: cur.x - GRID, y: cur.y }, { x: cur.x, y: cur.y + GRID }, { x: cur.x, y: cur.y - GRID }
        ];
		for (const nb of neighbors) {
			if (nb.x < 0 || nb.y < 0) continue;
			if (hitsHardSegment({ x: cur.x, y: cur.y }, nb, ctx.hardIndex, ctx.excludeInsts)) continue;
			const stepDir = dirOfStep({ x: cur.x, y: cur.y }, nb);
			const bend = (cur.dir === -1 || cur.dir === stepDir) ? 0 : 8;
			const otherAxis = (ctx.preferAxis === 'H' && !isHoriz(stepDir)) || (ctx.preferAxis === 'V' && isHoriz(stepDir));
			const preferPenalty = otherAxis ? 0.15 : 0;
			const sc = softCostForStepIndexed({ x: cur.x, y: cur.y }, nb, ctx.softIndex, ctx.netName, Math.max(Params.clear, 8), { crossSameNet: 4, crossWire: 25, nearWire: 3 });
			const g = cur.g + 1 + bend + preferPenalty + sc;
            const h = manhattan(nb, end) / GRID;
			const f = g + h;
			const k = key(nb.x, nb.y, stepDir);
			const prevG = best.get(k);
			if (prevG === undefined || g < prevG) { best.set(k, g); open.push({ x: nb.x, y: nb.y, g, h, f, dir: stepDir, prev: cur }); }
		}
	}
	return null;
}

function drawWire(points, netName) {
	if (!points || points.length < 2) return;
	const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
	const d = 'M ' + points.map(pt => `${pt.x} ${pt.y}`).join(' L ');
	p.setAttribute('d', d);
	p.setAttribute('class', 'wire');
	p.setAttribute('data-net', netName);
	$('#g-wires').appendChild(p);
	App.wires.push({ net: netName, points });
}

function drawJunctions(points) {
	const g = $('#g-junctions');
	points.forEach(p => {
		const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
		c.setAttribute('cx', String(p.x)); c.setAttribute('cy', String(p.y));
		c.setAttribute('r', '2.5'); c.setAttribute('class', 'junction');
		g.appendChild(c);
	});
}

function drawVCCSymbolUp(anchor, name) {
	// 使用一条与连线垂直的短横线，且短线位于连线末端（anchor）
	const g = $('#g-power-symbols');
	const grp = document.createElementNS('http://www.w3.org/2000/svg', 'g');
	const tick = document.createElementNS('http://www.w3.org/2000/svg', 'path');
	// 更短的短横线（总长约6px），中心在连线终点 anchor 处
	const tickLen = 6;
	tick.setAttribute('d', `M ${anchor.x - tickLen / 2} ${anchor.y} L ${anchor.x + tickLen / 2} ${anchor.y}`);
	tick.setAttribute('stroke', 'var(--vcc)'); tick.setAttribute('fill', 'none'); tick.setAttribute('stroke-width', '2'); tick.setAttribute('stroke-linecap', 'round');
	grp.appendChild(tick);
	// 文本更贴近短线（上方约3px）
	const t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
	t.setAttribute('class', 'power-text vcc'); t.setAttribute('x', String(anchor.x)); t.setAttribute('y', String(anchor.y - 3)); t.setAttribute('text-anchor', 'middle');
	t.textContent = name || 'VCC'; grp.appendChild(t);
	g.appendChild(grp);
	const obs = { x: anchor.x - 10, y: anchor.y - 16, w: 20, h: 24 };
	App.powerObstacles.push(obs);
	return { obs, lead: [{ x: anchor.x, y: anchor.y }, { x: anchor.x, y: anchor.y }] };
}

function drawGNDSymbolDown(anchor, name) {
	const g = $('#g-power-symbols');
	const grp = document.createElementNS('http://www.w3.org/2000/svg', 'g');
	const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
	p.setAttribute('d', `M ${anchor.x - GND_W / 2} ${anchor.y + 6} L ${anchor.x + GND_W / 2} ${anchor.y + 6} M ${anchor.x - GND_W / 2 + 3} ${anchor.y + 10} L ${anchor.x + GND_W / 2 - 3} ${anchor.y + 10} M ${anchor.x - GND_W / 2 + 6} ${anchor.y + 14} L ${anchor.x + GND_W / 2 - 6} ${anchor.y + 14}`);
	p.setAttribute('stroke', 'var(--gnd)'); p.setAttribute('fill', 'none'); p.setAttribute('stroke-width', '2'); grp.appendChild(p);
	const t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
	t.setAttribute('class', 'power-text gnd'); t.setAttribute('x', String(anchor.x)); t.setAttribute('y', String(anchor.y + GND_H + 10)); t.setAttribute('text-anchor', 'middle');
	t.textContent = name || 'GND'; grp.appendChild(t);
	const g2 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
	// 仅连接到最上层短横线（避免穿过符号）
	g2.setAttribute('d', `M ${anchor.x} ${anchor.y} L ${anchor.x} ${anchor.y + 6}`);
	g2.setAttribute('class', 'wire'); g2.setAttribute('stroke', 'var(--wire)'); g2.setAttribute('fill', 'none'); g2.setAttribute('stroke-width', String(WIRE_WIDTH)); g2.setAttribute('stroke-linecap', 'round'); grp.appendChild(g2);
	g.appendChild(grp);
	const obs = { x: anchor.x - GND_W / 2 - 2, y: anchor.y, w: GND_W + 4, h: GND_H + 20 };
	App.powerObstacles.push(obs);
	return { obs, lead: [{ x: anchor.x, y: anchor.y }, { x: anchor.x, y: anchor.y + 6 }] };
}

function drawGNDSymbolUp(anchor, name) {
	const g = $('#g-power-symbols');
	const grp = document.createElementNS('http://www.w3.org/2000/svg', 'g');
	const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
	p.setAttribute('d', `M ${anchor.x - GND_W / 2} ${anchor.y - 6} L ${anchor.x + GND_W / 2} ${anchor.y - 6} M ${anchor.x - GND_W / 2 + 3} ${anchor.y - 10} L ${anchor.x + GND_W / 2 - 3} ${anchor.y - 10} M ${anchor.x - GND_W / 2 + 6} ${anchor.y - 14} L ${anchor.x + GND_W / 2 - 6} ${anchor.y - 14}`);
	p.setAttribute('stroke', 'var(--gnd)'); p.setAttribute('fill', 'none'); p.setAttribute('stroke-width', '2'); grp.appendChild(p);
	const t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
	t.setAttribute('class', 'power-text gnd'); t.setAttribute('x', String(anchor.x)); t.setAttribute('y', String(anchor.y - GND_H - 4)); t.setAttribute('text-anchor', 'middle');
	t.textContent = name || 'GND'; grp.appendChild(t);
	const g2 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
	// 仅连接到最上层短横线（避免穿过符号）
	g2.setAttribute('d', `M ${anchor.x} ${anchor.y} L ${anchor.x} ${anchor.y - 6}`);
	g2.setAttribute('class', 'wire'); g2.setAttribute('stroke', 'var(--wire)'); g2.setAttribute('fill', 'none'); g2.setAttribute('stroke-width', String(WIRE_WIDTH)); g2.setAttribute('stroke-linecap', 'round'); grp.appendChild(g2);
	g.appendChild(grp);
	const obs = { x: anchor.x - GND_W / 2 - 2, y: anchor.y - GND_H - 20, w: GND_W + 4, h: GND_H + 20 };
	App.powerObstacles.push(obs);
	return { obs, lead: [{ x: anchor.x, y: anchor.y }, { x: anchor.x, y: anchor.y - 6 }] };
}

function drawGNDSymbolSide(anchor, side, name) {
	const g = $('#g-power-symbols');
	const grp = document.createElementNS('http://www.w3.org/2000/svg', 'g');
	const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
	
	let symPath, textX, textY, textAnchor, leadPath, obsRect;
	
	if (side === 'left') {
		// GND符号在左侧
		symPath = `M ${anchor.x - 6} ${anchor.y - GND_W / 2} L ${anchor.x - 6} ${anchor.y + GND_W / 2} M ${anchor.x - 10} ${anchor.y - GND_W / 2 + 3} L ${anchor.x - 10} ${anchor.y + GND_W / 2 - 3} M ${anchor.x - 14} ${anchor.y - GND_W / 2 + 6} L ${anchor.x - 14} ${anchor.y + GND_W / 2 - 6}`;
		// 文字位于符号左侧：以符号外缘为基准，再留 6px 间隙
		textX = anchor.x - (GND_W / 2 + 6); textY = anchor.y + 4; textAnchor = 'end';
		// 仅连接到最外侧竖线（6px）
		leadPath = `M ${anchor.x} ${anchor.y} L ${anchor.x - 6} ${anchor.y}`;
		obsRect = { x: anchor.x - GND_H - 28, y: anchor.y - GND_W / 2 - 2, w: GND_H + 30, h: GND_W + 4 };
	} else if (side === 'right') {
		// GND符号在右侧
		symPath = `M ${anchor.x + 6} ${anchor.y - GND_W / 2} L ${anchor.x + 6} ${anchor.y + GND_W / 2} M ${anchor.x + 10} ${anchor.y - GND_W / 2 + 3} L ${anchor.x + 10} ${anchor.y + GND_W / 2 - 3} M ${anchor.x + 14} ${anchor.y - GND_W / 2 + 6} L ${anchor.x + 14} ${anchor.y + GND_W / 2 - 6}`;
		// 文字位于符号右侧：以符号外缘为基准，再留 6px 间隙
		textX = anchor.x + (GND_W / 2 + 6); textY = anchor.y + 4; textAnchor = 'start';
		// 仅连接到最外侧竖线（6px）
		leadPath = `M ${anchor.x} ${anchor.y} L ${anchor.x + 6} ${anchor.y}`;
		obsRect = { x: anchor.x - 2, y: anchor.y - GND_W / 2 - 2, w: GND_H + 30, h: GND_W + 4 };
	} else {
		// 默认向下
		return drawGNDSymbolDown(anchor, name);
	}
	
	p.setAttribute('d', symPath);
	p.setAttribute('stroke', 'var(--gnd)'); p.setAttribute('fill', 'none'); p.setAttribute('stroke-width', '2'); grp.appendChild(p);
	const t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
	t.setAttribute('class', 'power-text gnd'); t.setAttribute('x', String(textX)); t.setAttribute('y', String(textY)); t.setAttribute('text-anchor', textAnchor);
	t.textContent = name || 'GND'; grp.appendChild(t);
	const g2 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
	g2.setAttribute('d', leadPath);
	g2.setAttribute('class', 'wire'); g2.setAttribute('stroke', 'var(--wire)'); g2.setAttribute('fill', 'none'); g2.setAttribute('stroke-width', String(WIRE_WIDTH)); g2.setAttribute('stroke-linecap', 'round'); grp.appendChild(g2);
	g.appendChild(grp);
	App.powerObstacles.push(obsRect);
	return { obs: obsRect, lead: side === 'left' ? [{ x: anchor.x - 6, y: anchor.y }, { x: anchor.x, y: anchor.y }] : [{ x: anchor.x + 6, y: anchor.y }, { x: anchor.x, y: anchor.y }] };
}

function drawVCCSymbolHorizontal(anchor, dir, name) {
	// 使用与连线垂直的短竖线，且短线位于连线末端（anchor）
	const g = $('#g-power-symbols');
	const grp = document.createElementNS('http://www.w3.org/2000/svg', 'g');
	const tick = document.createElementNS('http://www.w3.org/2000/svg', 'path');
	const tickLen = 6;
	tick.setAttribute('d', `M ${anchor.x} ${anchor.y - tickLen / 2} L ${anchor.x} ${anchor.y + tickLen / 2}`);
	tick.setAttribute('stroke', 'var(--vcc)'); tick.setAttribute('fill', 'none'); tick.setAttribute('stroke-width', '2'); tick.setAttribute('stroke-linecap', 'round');
	grp.appendChild(tick);
	// 文本更贴近短线（左右约3px）
	const t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
	t.setAttribute('class', 'power-text vcc');
	if (dir === 'left') { t.setAttribute('x', String(anchor.x - 3)); t.setAttribute('text-anchor', 'end'); }
	else { t.setAttribute('x', String(anchor.x + 3)); t.setAttribute('text-anchor', 'start'); }
	t.setAttribute('y', String(anchor.y + 4)); t.textContent = name || 'VCC'; grp.appendChild(t);
	g.appendChild(grp);
	const obs = { x: anchor.x - 12, y: anchor.y - 12, w: 24, h: 24 };
	App.powerObstacles.push(obs);
	if (dir === 'left') return { obs, lead: [{ x: anchor.x, y: anchor.y }, { x: anchor.x, y: anchor.y }] };
	return { obs, lead: [{ x: anchor.x, y: anchor.y }, { x: anchor.x, y: anchor.y }] };
}

function drawNetLabel(pt, name, side) {
	const g = $('#g-nettags');
	const grp = document.createElementNS('http://www.w3.org/2000/svg', 'g');
	
	let x = pt.x, y = pt.y, leadPath = null;
	const leadLen = 30; // 引线长度
	const textOffset = 6; // 文字与线的偏移距离
	
	// 添加文本元素
	const txt = document.createElementNS('http://www.w3.org/2000/svg', 'text');
	txt.setAttribute('class', 'nettag'); 
	txt.textContent = name;
	
	// 根据引脚所在的侧边，标签沿着引脚方向延伸
	if (side === 'left') { 
		// 引脚在左侧，水平向左延伸
		const lineEndX = pt.x - leadLen;
		leadPath = `M ${pt.x} ${pt.y} L ${lineEndX} ${pt.y}`;
		
		// 标签在水平线上方显示
		txt.setAttribute('text-anchor', 'middle');
		txt.setAttribute('x', String((pt.x + lineEndX) / 2)); // 线的中点
		txt.setAttribute('y', String(pt.y - textOffset)); // 线上方
	}
	else if (side === 'right') { 
		// 引脚在右侧，水平向右延伸
		const lineEndX = pt.x + leadLen;
		leadPath = `M ${pt.x} ${pt.y} L ${lineEndX} ${pt.y}`;
		
		// 标签在水平线上方显示
		txt.setAttribute('text-anchor', 'middle');
		txt.setAttribute('x', String((pt.x + lineEndX) / 2)); // 线的中点
		txt.setAttribute('y', String(pt.y - textOffset)); // 线上方
	}
	else if (side === 'top') { 
		// 引脚在顶部，垂直向上延伸
		const lineEndY = pt.y - leadLen;
		leadPath = `M ${pt.x} ${pt.y} L ${pt.x} ${lineEndY}`;
		
		// 标签在垂直线左侧，垂直排列
		txt.setAttribute('text-anchor', 'middle');
		txt.setAttribute('x', String(pt.x - textOffset));
		txt.setAttribute('y', String((pt.y + lineEndY) / 2)); // 线的中点
		txt.setAttribute('writing-mode', 'vertical-rl'); // 垂直排列
		txt.setAttribute('text-orientation', 'mixed');
	}
	else { 
		// 引脚在底部，垂直向下延伸
		const lineEndY = pt.y + leadLen;
		leadPath = `M ${pt.x} ${pt.y} L ${pt.x} ${lineEndY}`;
		
		// 标签在垂直线左侧，垂直排列
		txt.setAttribute('text-anchor', 'middle');
		txt.setAttribute('x', String(pt.x - textOffset));
		txt.setAttribute('y', String((pt.y + lineEndY) / 2)); // 线的中点
		txt.setAttribute('writing-mode', 'vertical-rl'); // 垂直排列
		txt.setAttribute('text-orientation', 'mixed');
	}
	
	// 添加延长线
	if (leadPath) {
		const lead = document.createElementNS('http://www.w3.org/2000/svg', 'path');
		lead.setAttribute('d', leadPath);
		lead.setAttribute('class', 'nettag-lead');
		lead.setAttribute('stroke', 'var(--wire)');
		lead.setAttribute('stroke-width', '2');
		lead.setAttribute('fill', 'none');
		grp.appendChild(lead);
	}
	
	grp.appendChild(txt);
	g.appendChild(grp);
	App.netLabels.push({ name, x: parseFloat(txt.getAttribute('x')), y: parseFloat(txt.getAttribute('y')) });
}

function lineHitsObstacles(a, b, obs, exclude = []) {
	for (const o of obs) { if (exclude.includes(o.inst)) continue; if (segIntersectsRect(a, b, o)) return true; }
	return false;
}

const Router = { aborted: false };
export function abortRouting() { Router.aborted = true; }
function resetRoutingAbort() { Router.aborted = false; }

function getStubLenForInst(inst) { return inst && (Array.isArray(inst.pins) && inst.pins.length >= 8) ? Math.max(Params.powerStubIC, 32) : Params.powerStub; }

function getEscapeRoute(inst, pinNum, obstacles, prefer) {
	const pinAbs = pinAbsByNumber(inst, pinNum); if (!pinAbs) return null;
	const side = sideOfPinOnInst(inst, pinAbs);
	const len = Math.max(Params.escape, 40);
	let primarySide = side;
	if (prefer && prefer.center) {
		const dx = prefer.center.x - pinAbs.x; const dy = prefer.center.y - pinAbs.y;
		primarySide = Math.abs(dx) >= Math.abs(dy) ? (dx < 0 ? 'left' : 'right') : (dy < 0 ? 'top' : 'bottom');
	}
	let targetPt;
	if (primarySide === 'left') targetPt = { x: pinAbs.x - len, y: pinAbs.y };
	else if (primarySide === 'right') targetPt = { x: pinAbs.x + len, y: pinAbs.y };
	else if (primarySide === 'top') targetPt = { x: pinAbs.x, y: pinAbs.y - len };
	else targetPt = { x: pinAbs.x, y: pinAbs.y + len };
	targetPt = { x: snap(targetPt.x), y: snap(targetPt.y) };
	const tryPath = (points) => { const simplified = simplifyPath(points); for (let i = 0; i < simplified.length - 1; i++) { if (lineHitsObstacles(simplified[i], simplified[i + 1], obstacles, [inst])) return null; } return simplified; };
	let path;
	if (primarySide === 'left' || primarySide === 'right') { path = tryPath([pinAbs, { x: targetPt.x, y: pinAbs.y }, targetPt]); if (path) return path; path = tryPath([pinAbs, { x: pinAbs.x, y: targetPt.y }, targetPt]); if (path) return path; }
	else { path = tryPath([pinAbs, { x: pinAbs.x, y: targetPt.y }, targetPt]); if (path) return path; path = tryPath([pinAbs, { x: targetPt.x, y: pinAbs.y }, targetPt]); if (path) return path; }
    const jog = GRID * 2; for (const d of [jog, -jog]) { let p1, p2, p3; if (primarySide==='left'||primarySide==='right'){ p1={x:pinAbs.x,y:pinAbs.y+d}; p2={x:targetPt.x,y:p1.y}; p3=targetPt; } else { p1={x:pinAbs.x+d,y:pinAbs.y}; p2={x:p1.x,y:targetPt.y}; p3=targetPt; } path = tryPath([pinAbs,p1,p2,p3]); if (path) return path; }
	return null;
}

function calculatePathLength(path) { let len = 0; for (let i = 0; i < path.length - 1; i++) len += manhattan(path[i], path[i + 1]); return len; }

export async function routeAllNets() {
	$('#g-wires').innerHTML = '';
	$('#g-junctions').innerHTML = '';
	$('#g-nettags').innerHTML = '';
	$('#g-power-symbols').innerHTML = '';
	App.wires = []; App.netLabels = []; App.powerObstacles = [];
	App.stats = { totalNets: 0, wiredNets: 0, labeledNets: 0 };
	resetRoutingAbort();

	const byRef = new Map(App.inst.map(i => [i.ref, i]));
	const hardObstacles = App.inst.map(rectForInstRoute);
	const hardIndex = new SpatialIndex(64);
	hardObstacles.forEach((o, ii) => hardIndex.addRect({ ...o, __id: 'hard_' + ii }, { inst: o.inst }));
	const softIndex = new SpatialIndex(64);

	const nets = (App.plan.nets || []).slice().filter(n => n && Array.isArray(n.nodes));
	const keyNames = /CLK|SCL|SDA|RST|RESET|BOOT|TX|RX|SWD|JTAG/i;
	const scored = nets.map(n => {
		const refs = new Set((n.nodes || []).map(nd => nd.ref));
		const clusters = new Set();
		refs.forEach(r => { const inst = byRef.get(r); if (inst) { const cid = App.compToCluster.get(inst.id); if (cid) clusters.add(cid); } });
		const intra = clusters.size <= 1 ? 1 : 0; const pins = (n.nodes || []).length; const hasKey = keyNames.test(n.name || '') ? 1 : 0; const power = isPowerName(n.name) ? 1 : 0;
		return { net: n, score: (power ? 1000 : 0) + intra * 500 + (hasKey ? 50 : 0) + Math.min(30, pins) };
	}).sort((a, b) => b.score - a.score);
	const totalNets = scored.length;

	for (let idx = 0; idx < scored.length; idx++) {
		const net = scored[idx].net; App.stats.totalNets++;
		if (isPowerName(net.name)) {
			net.nodes.forEach(node => {
				const inst = byRef.get(node.ref); const pinPt = pinAbsByNumber(inst, node.pin); if (!inst || !pinPt) return;
				const side = sideOfPinOnInst(inst, pinPt); const stubLen = getStubLenForInst(inst);
				let symPt, wirePts;
				if (/^(GND|VSS|AGND|DGND|0V)$/i.test(net.name)) {
					// 对于GND，分析符号形状，连接到最长边而不穿过器件
					const instSize = effSize(inst);
					const isWider = instSize.w > instSize.h;
					
					// 根据器件的最长边和引脚位置决定GND符号位置
					if (isWider) {
						// 器件更宽，最长边是水平边，GND应该连接到上边或下边
						if (side === 'top') {
							// 引脚在顶部，GND向上
							symPt = { x: pinPt.x, y: pinPt.y - stubLen };
							wirePts = [{ x: pinPt.x, y: pinPt.y }, symPt];
							// 绘制向上的GND（需要实现）
							drawGNDSymbolUp(symPt, net.name);
						} else {
							// 其他情况向下连接到底边
							symPt = { x: pinPt.x, y: pinPt.y + stubLen };
							wirePts = [{ x: pinPt.x, y: pinPt.y }, symPt];
							drawGNDSymbolDown(symPt, net.name);
						}
					} else {
						// 器件更高，最长边是垂直边，GND应该连接到左边或右边
						if (side === 'left') {
							symPt = { x: pinPt.x - stubLen, y: pinPt.y };
							wirePts = [{ x: pinPt.x, y: pinPt.y }, symPt];
							drawGNDSymbolSide(symPt, 'left', net.name);
						} else if (side === 'right') {
							symPt = { x: pinPt.x + stubLen, y: pinPt.y };
							wirePts = [{ x: pinPt.x, y: pinPt.y }, symPt];
							drawGNDSymbolSide(symPt, 'right', net.name);
						} else {
							// 引脚在上下边时，选择不穿过器件的方向
							symPt = { x: pinPt.x, y: pinPt.y + stubLen };
							wirePts = [{ x: pinPt.x, y: pinPt.y }, symPt];
							drawGNDSymbolDown(symPt, net.name);
						}
					}
				}
				else {
					if (side === 'top') { symPt = { x: pinPt.x, y: pinPt.y - stubLen }; wirePts = [{ x: pinPt.x, y: pinPt.y }, symPt]; drawVCCSymbolUp(symPt, net.name); }
					else if (side === 'left') { symPt = { x: pinPt.x - stubLen, y: pinPt.y }; wirePts = [{ x: pinPt.x, y: pinPt.y }, symPt]; drawVCCSymbolHorizontal(symPt, 'left', net.name); }
					else if (side === 'right') { symPt = { x: pinPt.x + stubLen, y: pinPt.y }; wirePts = [{ x: pinPt.x, y: pinPt.y }, symPt]; drawVCCSymbolHorizontal(symPt, 'right', net.name); }
					else { drawNetLabel(pinPt, net.name, side); }
				}
				if (wirePts) { drawWire(wirePts, net.name); for (let i = 0; i < wirePts.length - 1; i++) { const r = segToRect(wirePts[i], wirePts[i + 1], 4); softIndex.addRect({ ...r, __id: `wire_${net.name}_${Math.random()}` }, { net: net.name }); } }
			});
			App.stats.wiredNets++; if (idx % 2 === 0) await nextFrame(); continue;
		}

		const pinData = net.nodes.map(n => ({ inst: byRef.get(n.ref), pinNum: n.pin })).filter(p => p.inst);
		if (pinData.length < 2) { App.stats.labeledNets++; continue; }
		const pinPts = pinData.map(p => pinAbsByNumber(p.inst, p.pinNum)).filter(Boolean);
		if (pinPts.length < 2) { App.stats.labeledNets++; continue; }
		const xs = pinPts.map(p => p.x), ys = pinPts.map(p => p.y);
		const preferAxis = (Math.max(...xs) - Math.min(...xs) >= Math.max(...ys) - Math.min(...ys)) ? 'H' : 'V';
		const center = { x: snap([...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]), y: snap([...ys].sort((a, b) => a - b)[Math.floor(ys.length / 2)]) };
		const escapes = new Map(); let okEsc = true;
		for (const p of pinData) { const r = getEscapeRoute(p.inst, p.pinNum, hardObstacles, { axis: preferAxis, center }); if (!r) { okEsc = false; break; } escapes.set(`${p.inst.ref}-${p.pinNum}`, r); }
		if (!okEsc) {
			pinData.forEach(p => { const pt = pinAbsByNumber(p.inst, p.pinNum); if (pt) drawNetLabel(pt, net.name, sideOfPinOnInst(p.inst, pt)); });
			App.stats.labeledNets++; if (idx % 2 === 0) await nextFrame(); continue;
		}

		let seedIdx = 0, best = Infinity; for (let i = 0; i < pinPts.length; i++) { const d = manhattan(pinPts[i], center); if (d < best) { best = d; seedIdx = i; } }
		const treePaths = []; const used = new Array(pinData.length).fill(false); const seedPD = pinData[seedIdx]; const seedRt = escapes.get(`${seedPD.inst.ref}-${seedPD.pinNum}`); treePaths.push(seedRt); used[seedIdx] = true; drawWire(seedRt, net.name);
		for (let i = 0; i < seedRt.length - 1; i++) { const r = segToRect(seedRt[i], seedRt[i + 1], 4); softIndex.addRect({ ...r, __id: `wire_${net.name}_${Math.random()}` }, { net: net.name }); }
        let anchors = (function sampleAnchors(paths, stride = 80, maxAnchors = 24) { const anchors = []; const step = Math.max(1, Math.round(stride / GRID)); for (const seg of paths) { for (let i = 0; i < seg.length; i++) { const p = seg[i]; if (i === 0 || i === seg.length - 1 || (i % step === 0)) anchors.push(p); } } const uniq = new Map(); anchors.forEach(p => uniq.set(`${p.x},${p.y}`, p)); const list = [...uniq.values()]; if (list.length <= maxAnchors) return list; const endpoints = []; paths.forEach(seg => { if (seg.length) { endpoints.push(seg[0], seg[seg.length - 1]); } }); const epMap = new Map(); endpoints.forEach(p => epMap.set(`${p.x},${p.y}`, p)); const epList = [...epMap.values()]; const rest = list.filter(p => !epMap.has(`${p.x},${p.y}`)); const stridePick = Math.max(1, Math.floor(rest.length / Math.max(1, (maxAnchors - epList.length)))); const picked = rest.filter((_, i) => i % stridePick === 0).slice(0, Math.max(0, maxAnchors - epList.length)); return [...epList, ...picked]; }) (treePaths, 80, 24);
		let allOK = true;
		const K_NEAREST = 6; const BUDGET = { timeLimitMs: 150, visitLimit: 80000 };
		for (let remain = pinData.length - 1; remain > 0; remain--) {
			let bestI = -1, bestPath = null, bestJoin = null, bestCost = Infinity;
			for (let i = 0; i < pinData.length; i++) {
				if (used[i]) continue; const pd = pinData[i]; const esc = escapes.get(`${pd.inst.ref}-${pd.pinNum}`); const escEnd = esc[esc.length - 1]; const excludeForThisPath = new Set([pd.inst]);
				const cand = anchors.map(a => ({ a, d: manhattan(escEnd, a) })).sort((x, y) => x.d - y.d).slice(0, K_NEAREST);
				for (const { a } of cand) {
					const path = findPathAStar(escEnd, a, { hardIndex, softIndex, excludeInsts: excludeForThisPath, preferAxis, netName: net.name, timeLimitMs: BUDGET.timeLimitMs, visitLimit: BUDGET.visitLimit, abort: () => Router.aborted });
					if (!path) continue;
					const currentLength = calculatePathLength(path); if (currentLength > Params.maxWireLength) continue;
					const cost = path.length; if (cost < bestCost) { bestCost = cost; bestPath = path; bestI = i; bestJoin = a; }
				}
			}
			if (bestI === -1 || !bestPath) { allOK = false; break; }
			const pd = pinData[bestI]; const esc = escapes.get(`${pd.inst.ref}-${pd.pinNum}`); const full = simplifyPath([...esc, ...bestPath.slice(1)]); drawWire(full, net.name);
			for (let i = 0; i < full.length - 1; i++) { const r = segToRect(full[i], full[i + 1], 4); softIndex.addRect({ ...r, __id: `wire_${net.name}_${Math.random()}` }, { net: net.name }); }
            treePaths.push(full); used[bestI] = true; if (bestJoin) drawJunctions([bestJoin]); anchors = (function sampleAgain(paths, stride = 80, maxAnchors = 24) { const anchors = []; const step = Math.max(1, Math.round(stride / GRID)); for (const seg of paths) for (let i = 0; i < seg.length; i++) { const p = seg[i]; if (i === 0 || i === seg.length - 1 || (i % step === 0)) anchors.push(p); } const uniq = new Map(); anchors.forEach(p => uniq.set(`${p.x},${p.y}`, p)); const list = [...uniq.values()]; if (list.length <= maxAnchors) return list; const endpoints = []; paths.forEach(seg => { if (seg.length) { endpoints.push(seg[0], seg[seg.length - 1]); } }); const epMap = new Map(); endpoints.forEach(p => epMap.set(`${p.x},${p.y}`, p)); const epList = [...epMap.values()]; const rest = list.filter(p => !epMap.has(`${p.x},${p.y}`)); const stridePick = Math.max(1, Math.floor(rest.length / Math.max(1, (maxAnchors - epList.length)))); const picked = rest.filter((_, i) => i % stridePick === 0).slice(0, Math.max(0, maxAnchors - epList.length)); return [...epList, ...picked]; })(treePaths, 80, 24);
			if (remain % 2 === 0) await nextFrame(); if (Router.aborted) break;
		}
		if (allOK) App.stats.wiredNets++; else { pinData.forEach((p, i) => { if (!used[i]) { const pt = pinAbsByNumber(p.inst, p.pinNum); if (pt) drawNetLabel(pt, net.name, sideOfPinOnInst(p.inst, pt)); } }); App.stats.labeledNets++; }
		if (idx % 2 === 0) await nextFrame(); if (Router.aborted) break;
	}
	$('#wire-count').textContent = App.wires.length; $('#label-count').textContent = App.netLabels.length; $('#success-rate').textContent = totalNets > 0 ? `${Math.round(((App.stats.wiredNets + App.stats.labeledNets) / totalNets) * 100)}%` : '--';
}


