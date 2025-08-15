import { App, $, $$, uuid, snap } from './state.js';
import { collectCandidatesByKey, collectCandidatesByValue } from './lib.js';
import { effSize, instTransform } from './geometry.js';

function allDistinctRecs() {
	const set = new Set();
	for (const arr of App.lib.values()) arr.forEach(r => set.add(r));
	return [...set];
}

function expectedPinCount(ref) {
	const s = new Set();
	(App.plan.nets || []).forEach(net => {
		(net.nodes || []).forEach(nd => {
			if (nd.ref === ref) s.add(String(nd.pin || ''));
		});
	});
	return s.size || 0;
}

function expectedPinNumbers(ref) {
	const s = new Set();
	(App.plan.nets || []).forEach(net => {
		(net.nodes || []).forEach(nd => {
			if (nd.ref === ref) s.add(String(nd.pin));
		});
	});
	return [...s];
}

function pickBestByPins(cands, need) {
	if (!cands || !cands.length) return null;
	if (cands.length === 1) return cands[0];
	const scored = cands.map(r => ({ r, score: Math.abs(((r.pins?.length) || 0) - need) }));
	scored.sort((a, b) => a.score - b.score);
	return scored[0].r;
}

export function pickSymbol(c) {
	const need = expectedPinCount(c.ref);
	if (c.symbolKey) {
		const byKey = pickBestByPins(collectCandidatesByKey(c.symbolKey), need);
		if (byKey) return byKey;
	}
	const byVal = pickBestByPins(collectCandidatesByValue(c.value), need);
	if (byVal) return byVal;
	return null;
}

function genPlaceholder(comp) {
	const pinNumsRaw = expectedPinNumbers(comp.ref);
	const count = Math.max(pinNumsRaw.length, 8);
	const numeric = pinNumsRaw.filter(p => /^\d+$/.test(p)).map(p => Number(p)).sort((a, b) => a - b).map(String);
	const nonNum = pinNumsRaw.filter(p => !(/^\d+$/.test(p)));
	const orderedPins = [...numeric, ...nonNum];
	while (orderedPins.length < count) orderedPins.push(String(orderedPins.length + 1));
	const rows = Math.ceil(count / 2);
	const h = Math.max(rows * 15 + 30, 80), w = 140;
	const leftPins = orderedPins.slice(0, rows);
	const rightPins = orderedPins.slice(rows);
	const pins = [];
	for (let i = 0; i < leftPins.length; i++) {
		const y = 15 + i * ((h - 30) / Math.max(1, rows - 1));
		pins.push({ number: leftPins[i], name: '', x: 0, y });
	}
	for (let i = 0; i < rightPins.length; i++) {
		const y = 15 + i * ((h - 30) / Math.max(1, rows - 1));
		pins.push({ number: rightPins[i], name: '', x: w, y });
	}
	const vb = `0 0 ${w} ${h}`;
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}"><rect x="10" y="5" width="${w - 20}" height="${h - 10}" fill="#FEFBCB" stroke="#8B0000"/>${pins.map(p => `<g class="connection-point" data-pin-number="${p.number}" data-x="${p.x}" data-y="${p.y}"><circle cx="${p.x}" cy="${p.y}" r="0.6" fill="transparent"/></g>`).join('')}<metadata id="eda-meta">${JSON.stringify({ format: "EDA-SmartSymbol-1.0", component: { lib_reference: "__placeholder__", anchor_schema: "pin", pins } })}</metadata></svg>`;
	return { key: '__placeholder__', label: 'placeholder', svgText: svg, viewBox: vb, w, h, pins };
}

function prefixIDs(root, prefix) {
	const idMap = new Map();
	root.querySelectorAll('[id]').forEach(el => {
		const old = el.getAttribute('id');
		const neo = prefix + old;
		idMap.set(old, neo);
		el.setAttribute('id', neo);
	});
	const attrs = ['fill', 'stroke', 'filter', 'clip-path', 'mask', 'marker-start', 'marker-mid', 'marker-end', 'href', 'xlink:href'];
	root.querySelectorAll('*').forEach(el => {
		attrs.forEach(a => {
			const val = el.getAttribute(a);
			if (!val) return;
			let v = val;
			idMap.forEach((neo, old) => {
				v = v.replace(new RegExp(`url\\(#${old}\\)`, 'g'), `url(#${neo})`);
				if ((a === 'href' || a === 'xlink:href') && v === `#${old}`) v = `#${neo}`;
			});
			if (v !== val) el.setAttribute(a, v);
		});
	});
}

function buildSymbolNode(inst) {
	try {
		const parser = new DOMParser();
		const doc = parser.parseFromString(inst.symbol.svgText, 'image/svg+xml');
		const svgInner = doc.documentElement;
		prefixIDs(svgInner, inst.id + '_');
		const vb = (svgInner.getAttribute('viewBox') || '0 0 100 60').split(/\s+/).map(Number);
		const w = Math.max(1, Math.round(vb[2] || inst.symbol.w || 100));
		const h = Math.max(1, Math.round(vb[3] || inst.symbol.h || 60));
		svgInner.setAttribute('width', String(w));
		svgInner.setAttribute('height', String(h));
		return document.importNode(svgInner, true);
	} catch (e) {
		const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
		const r = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
		r.setAttribute('x', '0');
		r.setAttribute('y', '0');
		r.setAttribute('width', String(inst.symbol?.w || 120));
		r.setAttribute('height', String(inst.symbol?.h || 60));
		r.setAttribute('fill', '#FFE');
		r.setAttribute('stroke', '#8B0000');
		g.appendChild(r);
		return g;
	}
}

export function renderInstances() {
	const g = $('#g-symbols');
	g.innerHTML = '';
	App.inst.forEach(inst => {
		const el = document.createElementNS('http://www.w3.org/2000/svg', 'g');
		el.classList.add('symbol');
		el.setAttribute('data-id', inst.id);
		el.setAttribute('transform', instTransform(inst));
		const sub = buildSymbolNode(inst);
		el.appendChild(sub);
		const size = effSize(inst);
		const t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
		t.setAttribute('class', 'ref');
		t.setAttribute('x', String(size.w / 2));
		t.setAttribute('y', '-6');
		t.setAttribute('text-anchor', 'middle');
		t.textContent = inst.ref + (inst.value ? (' (' + inst.value + ')') : '');
		el.appendChild(t);
		g.appendChild(el);
	});
	// 启用拖拽
	enableDrag();
}

export function enableDrag() {
	let dragging = null, start = { x: 0, y: 0 }, orig = { x: 0, y: 0 };
	$$('#g-symbols .symbol').forEach(el => {
		el.onmousedown = (ev) => {
			if (ev.button !== 0) return;
			const id = el.getAttribute('data-id');
			dragging = App.inst.find(i => i.id === id);
			if (!dragging) return;
			start = { x: ev.clientX, y: ev.clientY };
			orig = { x: dragging.x, y: dragging.y };
			ev.preventDefault();
		};
	});
	window.onmousemove = (ev) => {
		if (!dragging) return;
		const svg = $('#schematic');
		const rc = svg.getBoundingClientRect();
		const dx = (ev.clientX - start.x) / rc.width * App.cam.w,
			dy = (ev.clientY - start.y) / rc.height * App.cam.h;
		dragging.x = snap(orig.x + dx);
		dragging.y = snap(orig.y + dy);
		const el = $(`#g-symbols .symbol[data-id="${dragging.id}"]`);
		if (el) el.setAttribute('transform', instTransform(dragging));
	};
	window.onmouseup = () => { dragging = null; };
}

export function buildInstances() {
	App.inst = (App.plan.components || []).map((c, idx) => {
		const sym = pickSymbol(c) || genPlaceholder(c);
		const pins = Array.isArray(sym.pins) ? sym.pins.slice() : [];
		return {
			id: uuid(),
			ref: c.ref,
			value: c.value || '',
			symbol: { ...sym, pins },
			x: 140 + idx * 220,
			y: 160,
			w: sym.w,
			h: sym.h,
			pins,
			deg: 0,
			rot: 0
		};
	});
	// 度数统计
	const deg = new Map(App.inst.map(i => [i.ref, 0]));
	(App.plan.nets || []).forEach(net => {
		const refs = [...new Set((net.nodes || []).map(n => n.ref))];
		refs.forEach(r => deg.set(r, (deg.get(r) || 0) + refs.length - 1));
	});
	App.inst.forEach(i => i.deg = deg.get(i.ref) || 0);
	// 渲染
	renderInstances();
	$('#inst-count').textContent = String(App.inst.length);
}


