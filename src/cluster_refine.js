import { App, GRID, Params, PLACEMENT_MARGIN, snap } from './state.js';
import { effSize, inflateRect, rectsOverlap, pinAbsByNumber, sideOfPinOnInst } from './geometry.js';
import { isIC, isPassive, isPowerName } from './types.js';
import { renderInstances } from './symbols.js';

export function assignPrimaryICs() {
	App.passiveToPrimaryIC.clear();
	const byRef = new Map(App.inst.map(i => [i.ref, i]));
	const passives = App.inst.filter(isPassive);
	const ics = App.inst.filter(isIC);
	if (!passives.length || !ics.length) return;
	for (const passive of passives) {
		const connections = new Map();
		for (const net of App.plan.nets) {
			if (isPowerName(net.name)) continue;
			const nodes = net.nodes || [];
			const hasPassive = nodes.some(n => n.ref === passive.ref);
			if (!hasPassive) continue;
			for (const node of nodes) {
				const inst = byRef.get(node.ref);
				if (inst && isIC(inst)) connections.set(inst.id, (connections.get(inst.id) || 0) + 1);
			}
		}
		if (connections.size > 0) {
			const bestICId = [...connections.entries()].sort((a, b) => b[1] - a[1])[0][0];
			App.passiveToPrimaryIC.set(passive.id, bestICId);
		}
	}
}

export function getClusterRectForInst(inst) {
	const cid = App.compToCluster.get(inst.id);
	if (!cid) return null;
	const c = App.clusters.find(cc => cc.id === cid);
	return c?.rect || null;
}

export function placePassivesAroundICs() {
	const byId = new Map(App.inst.map(i => [i.id, i]));
	const byRef = new Map(App.inst.map(i => [i.ref, i]));
	const belts = new Map();
	const directPairs = new Map();
	for (const net of (App.plan.nets || [])) {
		if (isPowerName(net.name)) continue;
		const nodes = net.nodes || [];
		if (nodes.length === 2) {
			const aRef = nodes[0].ref, bRef = nodes[1].ref;
			const a = byRef.get(aRef), b = byRef.get(bRef);
			if (a && b) {
				if (isPassive(a) && isIC(b)) { if (!directPairs.has(a.id)) directPairs.set(a.id, new Set()); directPairs.get(a.id).add(b.id); }
				if (isPassive(b) && isIC(a)) { if (!directPairs.has(b.id)) directPairs.set(b.id, new Set()); directPairs.get(b.id).add(a.id); }
			}
		}
	}

	for (const [passiveId, icId] of App.passiveToPrimaryIC.entries()) {
		const passive = byId.get(passiveId);
		const ic = byId.get(icId);
		if (!passive || !ic) continue;
		if (!belts.has(ic.id)) belts.set(ic.id, { ic, left: [], right: [], top: [], bottom: [] });
		const belt = belts.get(ic.id);
		let icPinAbs = { x: ic.x + effSize(ic).w / 2, y: ic.y + effSize(ic).h / 2 };
		for (const net of App.plan.nets) {
			const nodes = net.nodes || [];
			const passiveNode = nodes.find(n => n.ref === passive.ref);
			const icNode = nodes.find(n => n.ref === ic.ref);
			if (passiveNode && icNode) {
				const p = pinAbsByNumber(ic, icNode.pin);
				if (p) { icPinAbs = p; break; }
			}
		}
		const side = sideOfPinOnInst(ic, icPinAbs);
		const isDirect = !!directPairs.get(passive.id)?.has(ic.id);
		belt[side].push({ pv: passive, at: icPinAbs, isDirect });
	}

	for (const [icId, belt] of belts.entries()) {
		const ic = belt.ic; const c = effSize(ic); const cy = ic.y + c.h / 2;
		const lr = belt.left.length + belt.right.length; const tb = belt.top.length + belt.bottom.length;
		if (lr > tb * 1.6) {
			const overflow = Math.max(1, Math.floor((lr - tb * 1.6) / 2));
			const pullFrom = [...belt.left, ...belt.right].sort((a, b) => Math.abs(a.at.y - cy) - Math.abs(b.at.y - cy)).slice(-overflow);
			for (const it of pullFrom) {
				['left', 'right'].forEach(s => { const idx = belt[s].indexOf(it); if (idx >= 0) belt[s].splice(idx, 1); });
				if (it.at.y < cy) belt.top.push(it); else belt.bottom.push(it);
			}
		}
	}

	function clamp(val, min, max) { return Math.max(min, Math.min(max, val)); }
	function findFreeInsideCluster(clusterRect, size, avoidId) {
		const ox = snap(clusterRect.x + 8), oy = snap(clusterRect.y + 8);
		const maxX = snap(clusterRect.x + clusterRect.w - size.w - 8);
		const maxY = snap(clusterRect.y + clusterRect.h - size.h - 8);
		const step = Math.max(GRID * 2, Params.beltStep);
		const occ = App.inst.filter(i => i.id !== avoidId).map(i => { const s = effSize(i); return { x: i.x, y: i.y, w: s.w, h: s.h }; });
		for (let y = oy; y <= maxY; y += step) {
			for (let x = ox; x <= maxX; x += step) {
				const rect = { x, y, w: size.w, h: size.h };
				const inflated = inflateRect(rect, PLACEMENT_MARGIN / 2);
				if (!occ.some(r => rectsOverlap(inflated, r))) return { x, y };
			}
		}
		return { x: ox, y: oy };
	}

	const allPlacedPassives = new Set();
	for (const [icId, belt] of belts.entries()) {
		const ic = belt.ic; const icSize = effSize(ic);
		const clusterRect = getClusterRectForInst(ic) || { x: 0, y: 0, w: 2400, h: 1600 };
		for (const side of ['left', 'right', 'top', 'bottom']) {
			const items = belt[side]; if (!items.length) continue;
			items.sort((a, b) => (side === 'left' || side === 'right') ? (a.at.y - b.at.y) : (a.at.x - b.at.x));
			let cursor = (side === 'left' || side === 'right') ? (ic.y - 20) : (ic.x - 20);
			for (const item of items) {
				const pv = item.pv; if (allPlacedPassives.has(pv.id)) continue;
				const pvSize = effSize(pv); const localGap = item.isDirect ? Math.max(10, Params.beltGap - 10) : Params.beltGap;
				let placeX = 0, placeY = 0; let attempts = 0, placedOK = false;
				while (attempts < 100) {
					const currentPos = cursor + attempts * Params.beltStep;
					if (side === 'left') { placeX = snap(ic.x - pvSize.w - localGap); placeY = snap(currentPos); }
					else if (side === 'right') { placeX = snap(ic.x + icSize.w + localGap); placeY = snap(currentPos); }
					else if (side === 'top') { placeX = snap(currentPos); placeY = snap(ic.y - pvSize.h - localGap); }
					else { placeX = snap(currentPos); placeY = snap(ic.y + icSize.h + localGap); }
					placeX = clamp(placeX, snap(clusterRect.x + 8), snap(clusterRect.x + clusterRect.w - pvSize.w - 8));
					placeY = clamp(placeY, snap(clusterRect.y + 8), snap(clusterRect.y + clusterRect.h - pvSize.h - 8));
					const rect = { x: placeX, y: placeY, w: pvSize.w, h: pvSize.h };
					const inflatedRect = inflateRect(rect, PLACEMENT_MARGIN / 2);
					const occupiedRects = App.inst.filter(i => i.id !== pv.id).map(i => { const s = effSize(i); return { x: i.x, y: i.y, w: s.w, h: s.h }; });
					if (!occupiedRects.some(or => rectsOverlap(inflatedRect, or))) {
						pv.x = placeX; pv.y = placeY;
						cursor = (side === 'left' || side === 'right') ? (placeY + pvSize.h + Params.beltStep) : (placeX + pvSize.w + Params.beltStep);
						placedOK = true; break;
					}
					attempts++;
				}
				if (!placedOK) { const alt = findFreeInsideCluster(clusterRect, pvSize, pv.id); pv.x = alt.x; pv.y = alt.y; }
				allPlacedPassives.add(pv.id);
			}
		}
	}
	renderInstances();
}

export function resolveClusterOverlaps() {
	for (const c of App.clusters) {
		const list = [...c.members];
		const maxIter = 120;
		for (let iter = 0; iter < maxIter; iter++) {
			let moved = false;
			for (let i = 0; i < list.length; i++) {
				for (let j = i + 1; j < list.length; j++) {
					const a = list[i], b = list[j];
					const sa = effSize(a), sb = effSize(b);
					const ra = { x: a.x, y: a.y, w: sa.w, h: sa.h };
					const rb = { x: b.x, y: b.y, w: sb.w, h: sb.h };
					if (!rectsOverlap(inflateRect(ra, 2), inflateRect(rb, 2))) continue;
					const ax1 = ra.x, ay1 = ra.y, ax2 = ra.x + ra.w, ay2 = ra.y + ra.h;
					const bx1 = rb.x, by1 = rb.y, bx2 = rb.x + rb.w, by2 = rb.y + rb.h;
					const overlapX = Math.min(ax2, bx2) - Math.max(ax1, bx1);
					const overlapY = Math.min(ay2, by2) - Math.max(ay1, by1);
					if (overlapX <= 0 || overlapY <= 0) continue;
					if (overlapX < overlapY) {
						const dir = (a.x <= b.x) ? -1 : 1;
						const delta = snap(Math.max(GRID, overlapX / 2 + GRID));
						const aPassive = isPassive(a), bPassive = isPassive(b);
						if (aPassive && !bPassive) a.x = snap(a.x + dir * delta * 2);
						else if (bPassive && !aPassive) b.x = snap(b.x - dir * delta * 2);
						else { a.x = snap(a.x + dir * delta); b.x = snap(b.x - dir * delta); }
					} else {
						const dir = (a.y <= b.y) ? -1 : 1;
						const delta = snap(Math.max(GRID, overlapY / 2 + GRID));
						const aPassive = isPassive(a), bPassive = isPassive(b);
						if (aPassive && !bPassive) a.y = snap(a.y + dir * delta * 2);
						else if (bPassive && !aPassive) b.y = snap(b.y - dir * delta * 2);
						else { a.y = snap(a.y + dir * delta); b.y = snap(b.y - dir * delta); }
					}
					const cr = c.rect; const sa2 = effSize(a), sb2 = effSize(b);
					a.x = Math.min(Math.max(a.x, snap(cr.x + 4)), snap(cr.x + cr.w - sa2.w - 4));
					a.y = Math.min(Math.max(a.y, snap(cr.y + 4)), snap(cr.y + cr.h - sa2.h - 4));
					b.x = Math.min(Math.max(b.x, snap(cr.x + 4)), snap(cr.x + cr.w - sb2.w - 4));
					b.y = Math.min(Math.max(b.y, snap(cr.y + 4)), snap(cr.y + cr.h - sb2.h - 4));
					moved = true;
				}
			}
			if (!moved) break;
		}
	}
	renderInstances();
}


