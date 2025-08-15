import { App, DEFAULT_VB, GRID, CLUSTER_GAP, CLUSTER_PADDING, CLUSTER_SLOT, PLACEMENT_MARGIN, toast, snap } from './state.js';
import { effSize, rectsOverlap, inflateRect } from './geometry.js';
import { isIC, isPassive, isConnector } from './types.js';
import { renderInstances } from './symbols.js';

function buildAdjacencyWeighted() {
	const adj = new Map();
	const ensure = (a, b) => {
		if (!adj.has(a)) adj.set(a, new Map());
		if (!adj.get(a).has(b)) adj.get(a).set(b, 0);
	};
	(App.plan.nets || []).forEach(net => {
		if (/(^VCC$|^VDD$|^3V3$|^5V$|^\+5V$|^3\.3V$|^\+3\.3V$|^\+12V$|^12V$|^GND$|^VSS$|^AGND$|^DGND$|^0V$)/i.test(String(net.name || ''))) return;
		const refs = [...new Set((net.nodes || []).map(n => n.ref))];
		if (refs.length < 2) return;
		const w = (refs.length <= 2) ? 4 : (refs.length <= 4 ? 2 : 0.4);
		for (let i = 0; i < refs.length; i++) {
			for (let j = i + 1; j < refs.length; j++) {
				const a = refs[i], b = refs[j];
				ensure(a, b);
				ensure(b, a);
				adj.get(a).set(b, (adj.get(a).get(b) || 0) + w);
				adj.get(b).set(a, (adj.get(b).get(a) || 0) + w);
			}
		}
	});
	return adj;
}

export function createFunctionalClusters() {
	App.clusters = [];
	App.compToCluster = new Map();
	App.clusterGraph = new Map();

	const byRef = new Map(App.inst.map(i => [i.ref, i]));
	const adj = buildAdjacencyWeighted();
	const ics = App.inst.filter(isIC);

	if (!ics.length) {
		const c = { id: crypto.randomUUID?.() || Math.random().toString(36).slice(2), seed: null, members: new Set(App.inst), rect: null, center: null, externalWeight: 0 };
		App.clusters = [c];
		App.inst.forEach(i => App.compToCluster.set(i.id, c.id));
		toast('未检测到IC：已将全部器件归为单一功能簇', 'warn', 3400);
		return;
	}

	for (const ic of ics) {
		const c = { id: crypto.randomUUID?.() || Math.random().toString(36).slice(2), seed: ic, members: new Set([ic]), rect: null, center: null, externalWeight: 0 };
		App.clusters.push(c);
		App.compToCluster.set(ic.id, c.id);
	}

	const clusterBySeedId = new Map(App.clusters.map(c => [c.seed?.id, c]));

	const neighToIC = new Map();
	for (const inst of App.inst) {
		const N = adj.get(inst.ref) || new Map();
		const m = new Map();
		for (const [nbrRef, w] of N.entries()) {
			const nbr = byRef.get(nbrRef);
			if (!nbr) continue;
			if (isIC(nbr)) m.set(nbr.id, (m.get(nbr.id) || 0) + w);
		}
		neighToIC.set(inst.id, m);
	}

	const passives = App.inst.filter(isPassive);
	for (const p of passives) {
		if (App.compToCluster.has(p.id)) continue;
		const m = neighToIC.get(p.id) || new Map();
		if (m.size === 0) continue;
		let bestId = null, best = -Infinity;
		for (const [icId, w] of m.entries()) {
			if (w > best) { best = w; bestId = icId; }
		}
		if (bestId && clusterBySeedId.has(bestId)) {
			const c = clusterBySeedId.get(bestId);
			c.members.add(p);
			App.compToCluster.set(p.id, c.id);
		}
	}

	const adjById = new Map();
	for (const inst of App.inst) {
		const N = adj.get(inst.ref) || new Map();
		const m = new Map();
		for (const [nbrRef, w] of N.entries()) {
			const nbr = byRef.get(nbrRef);
			if (!nbr) continue;
			m.set(nbr.id, (m.get(nbr.id) || 0) + w);
		}
		adjById.set(inst.id, m);
	}

	const unassigned = App.inst.filter(i => !App.compToCluster.has(i.id));
	for (const u of unassigned) {
		let bestC = null, bestScore = -Infinity;
		for (const c of App.clusters) {
			let sc = 0;
			const am = adjById.get(u.id) || new Map();
			for (const m of c.members) sc += (am.get(m.id) || 0);
			if (sc > bestScore) { bestScore = sc; bestC = c; }
		}
		(bestC || App.clusters[0]).members.add(u);
		App.compToCluster.set(u.id, (bestC || App.clusters[0]).id);
	}

	function interClusterWeight(c1, c2) {
		let s = 0;
		for (const a of c1.members) {
			const am = adjById.get(a.id) || new Map();
			for (const b of c2.members) s += (am.get(b.id) || 0);
		}
		return s;
	}

	App.clusterGraph = new Map();
	for (const c of App.clusters) App.clusterGraph.set(c.id, new Map());
	for (let i = 0; i < App.clusters.length; i++) {
		for (let j = i + 1; j < App.clusters.length; j++) {
			const c1 = App.clusters[i], c2 = App.clusters[j];
			const w = interClusterWeight(c1, c2);
			if (w > 0) {
				App.clusterGraph.get(c1.id).set(c2.id, w);
				App.clusterGraph.get(c2.id).set(c1.id, w);
			}
		}
	}

	for (const c of App.clusters) {
		let ew = 0;
		const N = App.clusterGraph.get(c.id) || new Map();
		for (const [, w] of N) ew += w;
		c.externalWeight = ew;
	}
}

export function placeAndRouteClusters() {
	if (!App.clusters.length) return;

	function estimateClusterRect(cluster) {
		let area = 0;
		cluster.members.forEach(inst => {
			const s = effSize(inst);
			area += (s.w + PLACEMENT_MARGIN) * (s.h + PLACEMENT_MARGIN);
		});
		area *= 1.4;
		const minW = 360, minH = 260;
		let w = Math.max(minW, Math.round(Math.sqrt(area) + 2 * CLUSTER_PADDING));
		let h = Math.max(minH, Math.round(area / (w - 2 * CLUSTER_PADDING) + 2 * CLUSTER_PADDING));
		return { w: snap(w), h: snap(h) };
	}

	function icRank(ic) {
		if (!ic) return 0;
		const key = (ic.symbol?.key || ic.value || '').toLowerCase();
		let score = (isIC(ic) ? 20 : 0);
		if (/mcu|cpu|stm32|esp32|nrf52|atmega|8051|fpga|soc|microcontroller|processor/.test(key)) score += 40;
		score += (ic.deg || 0) * 1.5;
		return score;
	}

	App.clusters.forEach(c => {
		const s = estimateClusterRect(c);
		c.rect = { x: 0, y: 0, w: s.w, h: s.h };
		c.center = null;
	});

	let centerIdx = 0, best = -Infinity;
	App.clusters.forEach((c, idx) => {
		const score = (c.externalWeight || 0) + icRank(c.seed || null);
		if (score > best) { best = score; centerIdx = idx; }
	});

	const centerCluster = App.clusters[centerIdx];
	const centerPt = { x: snap(DEFAULT_VB.w / 2), y: snap(DEFAULT_VB.h / 2) };
	const placed = new Set();
	const placedRects = [];

	function placeClusterAt(c, cx, cy) {
		const x = snap(cx - c.rect.w / 2), y = snap(cy - c.rect.h / 2);
		c.rect.x = x; c.rect.y = y;
		c.center = { x: snap(cx), y: snap(cy) };
		placed.add(c.id);
		placedRects.push(inflateRect({ x, y, w: c.rect.w, h: c.rect.h }, CLUSTER_GAP));
	}

	placeClusterAt(centerCluster, centerPt.x, centerPt.y);

	function generateAnchors(maxRings) {
		const arr = [];
		for (let r = 1; r <= maxRings; r++) {
			const cnt = 8 * r;
			for (let k = 0; k < cnt; k++) {
				const ang = (2 * Math.PI * k) / cnt;
				const ax = snap(centerPt.x + Math.cos(ang) * CLUSTER_SLOT * r);
				const ay = snap(centerPt.y + Math.sin(ang) * CLUSTER_SLOT * r);
				arr.push({ x: ax, y: ay, ring: r, ang });
			}
		}
		return arr;
	}

	const anchors = generateAnchors(4);
	const neighOf = id => App.clusterGraph.get(id) || new Map();

	function scoreAnchor(c, anch) {
		const rect = { x: snap(anch.x - c.rect.w / 2), y: snap(anch.y - c.rect.h / 2), w: c.rect.w, h: c.rect.h };
		for (const pr of placedRects) if (rectsOverlap(inflateRect(rect, CLUSTER_GAP), pr)) return Infinity;
		let cost = anch.ring * 80;
		for (const [nid, w] of neighOf(c.id).entries()) {
			const nc = App.clusters.find(cc => cc.id === nid);
			if (!nc?.center) continue;
			const d = Math.abs(anch.x - nc.center.x) + Math.abs(anch.y - nc.center.y);
			cost += d * w;
		}
		return cost;
	}

	function connectionToPlaced(c) {
		let s = 0;
		for (const [nid, w] of neighOf(c.id)) if (placed.has(nid)) s += w;
		s += (c.seed ? 1 : 0) * 0.2;
		return s;
	}

	const remaining = App.clusters.map((c, idx) => ({ c, idx })).filter(x => x.idx !== centerIdx);
	while (remaining.length) {
		remaining.sort((a, b) => connectionToPlaced(b.c) - connectionToPlaced(a.c));
		const node = remaining.shift().c;
		let bestA = null, bestCost = Infinity;
		for (const a of anchors) {
			const cost = scoreAnchor(node, a);
			if (cost < bestCost) { bestCost = cost; bestA = a; }
		}
		if (!bestA) {
			let found = false;
			for (let r = 1; r <= 10 && !found; r++) {
				for (const [dx, dy] of [[1,0],[0,1],[-1,0],[0,-1],[1,1],[-1,1],[1,-1],[-1,-1]]) {
					const cx = snap(centerPt.x + dx * CLUSTER_SLOT * r);
					const cy = snap(centerPt.y + dy * CLUSTER_SLOT * r);
					const rect = { x: snap(cx - node.rect.w / 2), y: snap(cy - node.rect.h / 2), w: node.rect.w, h: node.rect.h };
					if (!placedRects.some(pr => rectsOverlap(inflateRect(rect, CLUSTER_GAP), pr))) {
						bestA = { x: cx, y: cy, ring: r, ang: 0 };
						found = true; break;
					}
				}
			}
			if (!bestA) bestA = { x: centerPt.x + CLUSTER_SLOT * (placedRects.length + 1), y: centerPt.y, ring: 1, ang: 0 };
		}
		placeClusterAt(node, bestA.x, bestA.y);
	}

	function placeMembersInCluster(cluster) {
		const cx = cluster.rect.x + cluster.rect.w / 2;
		const cy = cluster.rect.y + cluster.rect.h / 2;
		const placedLocal = [];
		function pushRect(inst) {
			const s = effSize(inst);
			placedLocal.push({ x: inst.x, y: inst.y, w: s.w, h: s.h });
		}
		function placeAtCenter(inst) {
			const s = effSize(inst);
			inst.x = snap(cx - s.w / 2);
			inst.y = snap(cy - s.h / 2);
			pushRect(inst);
		}
		function findFreeInside(s) {
			const step = GRID * 3;
			for (let ring = 0; ring < 100; ring++) {
				for (const [dx, dy] of [[1,0],[0,1],[-1,0],[0,-1],[1,1],[-1,1],[1,-1],[-1,-1]]) {
					const px = snap(cx + dx * ring * step - s.w / 2);
					const py = snap(cy + dy * ring * step - s.h / 2);
					const rect = { x: px, y: py, w: s.w, h: s.h };
					const inflated = inflateRect(rect, PLACEMENT_MARGIN);
					const out = rect.x < cluster.rect.x + 8 || rect.y < cluster.rect.y + 8 ||
						rect.x + rect.w > cluster.rect.x + cluster.rect.w - 8 ||
						rect.y + rect.h > cluster.rect.y + cluster.rect.h - 8;
					if (out) continue;
					if (!placedLocal.some(r => rectsOverlap(inflateRect(r, PLACEMENT_MARGIN), inflated))) return { x: px, y: py };
				}
			}
			return { x: snap(cluster.rect.x + 8), y: snap(cluster.rect.y + 8) };
		}
		if (cluster.seed) placeAtCenter(cluster.seed);
		const others = [...cluster.members].filter(m => m !== cluster.seed);
		others.sort((a, b) => {
			const ap = isPassive(a) ? 1 : 0, bp = isPassive(b) ? 1 : 0;
			if (ap !== bp) return ap - bp;
			const ac = isConnector(a) ? -1 : 0, bc = isConnector(b) ? -1 : 0;
			return bc - ac;
		});
		for (const inst of others) {
			const s = effSize(inst);
			const pos = findFreeInside(s);
			inst.x = pos.x; inst.y = pos.y;
			pushRect(inst);
		}
	}

	App.clusters.forEach(placeMembersInCluster);
	renderInstances();
	toast(`功能聚类完成：${App.clusters.length} 个簇；已完成簇级宏观布局`, 'ok', 2600);
}


