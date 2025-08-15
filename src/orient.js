import { App } from './state.js';
import { isPassive } from './types.js';
import { localToEffForAngle } from './geometry.js';

function instCenterForAngle(inst, ang) {
	const a = ((ang % 360) + 360) % 360;
	const w = inst.symbol.w, h = inst.symbol.h;
	const W = (a === 0 || a === 180) ? w : h, H = (a === 0 || a === 180) ? h : w;
	return { x: inst.x + W / 2, y: inst.y + H / 2 };
}

function pinSideForAngle(inst, pin, ang) {
	const p = localToEffForAngle(inst, pin.x, pin.y, ang);
	const w = (ang % 180 === 0) ? inst.symbol.w : inst.symbol.h,
		h = (ang % 180 === 0) ? inst.symbol.h : inst.symbol.w;
	const t = 5;
	if (p.x < t) return 'left';
	if (p.x > w - t) return 'right';
	if (p.y < t) return 'top';
	return 'bottom';
}

export function autoOrient() {
	const byRef = new Map(App.inst.map(i => [i.ref, i]));
	const pinUsage = new Map();
	(App.plan.nets || []).forEach(net => {
		const nodes = (net.nodes || []).filter(Boolean);
		for (const nd of nodes) {
			const inst = byRef.get(nd.ref);
			if (!inst) continue;
			const key = `${nd.ref}.${nd.pin}`;
			const neighCenters = [];
			for (const other of nodes) {
				if (other === nd) continue;
				const oi = byRef.get(other.ref);
				if (!oi) continue;
				const oc = instCenterForAngle(oi, oi.rot || 0);
				neighCenters.push(oc);
			}
			if (!pinUsage.has(key)) pinUsage.set(key, []);
			pinUsage.get(key).push(...neighCenters);
		}
	});

	for (const inst of App.inst) {
		const pinsList = Array.isArray(inst.pins) ? inst.pins : [];
		const pinsInNets = pinsList.filter(p => pinUsage.has(`${inst.ref}.${p.number}`));
		if (!pinsInNets.length) continue;
		const candidates = isPassive(inst) ? [0, 90, 180, 270] : [0, 180];
		let best = inst.rot || 0, costBest = Infinity;
		for (const ang of candidates) {
			const c = instCenterForAngle(inst, ang);
			let cost = 0;
			for (const p of pinsInNets) {
				const side = pinSideForAngle(inst, p, ang);
				const neighs = pinUsage.get(`${inst.ref}.${p.number}`) || [];
				for (const nc of neighs) {
					const dx = nc.x - c.x, dy = nc.y - c.y;
					const desired = Math.abs(dx) >= Math.abs(dy) ? (dx < 0 ? 'left' : 'right') : (dy < 0 ? 'top' : 'bottom');
					if (side !== desired) cost += 2;
					const horiz = (side === 'left' || side === 'right');
					if (horiz && Math.abs(dy) > Math.abs(dx)) cost += 0.5;
					if (!horiz && Math.abs(dx) > Math.abs(dy)) cost += 0.5;
				}
			}
			if (cost < costBest) { costBest = cost; best = ang; }
		}
		inst.rot = best;
	}
}


