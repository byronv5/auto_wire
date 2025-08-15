import { App, $, toast } from './state.js';

function extractBlocks(txt, openCh, closeCh) {
	const res = [];
	let depth = 0, start = -1;
	for (let i = 0; i < txt.length; i++) {
		const ch = txt[i];
		if (ch === openCh) {
			if (depth === 0) start = i + 1;
			depth++;
		}
		else if (ch === closeCh) {
			if (depth > 0) {
				depth--;
				if (depth === 0 && start >= 0) res.push(txt.slice(start, i));
			}
		}
	}
	return res;
}

function parseProtelNET(txt) {
	const components = [], nets = [];
	try {
		const compBlocks = extractBlocks(txt, '[', ']');
		for (const block of compBlocks) {
			const lines = block.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
			if (!lines.length) continue;
			const ref = lines[0], symbolKey = lines[1] || '', value = lines[2] || '';
			components.push({ ref, value, symbolKey });
		}
		const netBlocks = extractBlocks(txt, '(', ')');
		for (const block of netBlocks) {
			const lines = block.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
			if (!lines.length) continue;
			const name = lines[0], nodes = [];
			for (let i = 1; i < lines.length; i++) {
				const tokens = (lines[i] || '').split(/[,.\s]+/).filter(Boolean);
				for (const tok of tokens) {
					const mm = tok.match(/^(.*)-([^-]+)$/);
					if (mm) {
						const ref = mm[1].trim(), pin = mm[2].trim();
						if (ref && pin) nodes.push({ ref, pin });
					}
				}
			}
			nets.push({ name, nodes });
		}
	} catch (e) {
		console.warn('parseProtelNET error:', e);
	}
	return { components, nets };
}

function tryParseJSON(txt) {
	try {
		const js = JSON.parse(txt);
		if (Array.isArray(js.components) && Array.isArray(js.nets)) return js;
		if (js?.plan && Array.isArray(js.plan.components)) return js.plan;
	} catch { }
	return null;
}

export function importNetlistFromText(txt) {
	const plan = tryParseJSON(txt) || parseProtelNET(txt);
	if (!plan || !plan.components || !plan.nets) {
		toast('网表解析失败，格式无法识别', 'err');
		return;
	}
	App.plan = { components: plan.components || [], nets: plan.nets || [] };
	App.pinNetMap.clear();
	(App.plan.nets || []).forEach(net => {
		(net.nodes || []).forEach(nd => {
			const k = `${nd.ref}.${nd.pin}`;
			App.pinNetMap.set(k, net.name || '');
		});
	});
	refreshPlanView();
	showValidation(validatePlan());
}

export function importNetlistFile() {
	const inpt = document.createElement('input');
	inpt.type = 'file';
	inpt.accept = '.json,.txt,.net';
	inpt.onchange = async e => {
		const f = e.target.files?.[0];
		if (!f) return;
		const txt = await f.text();
		importNetlistFromText(txt);
	};
	inpt.click();
}

export function refreshPlanView() {
	$('#cmp-count').textContent = String(App.plan.components.length);
	$('#net-count').textContent = String(App.plan.nets.length);
	const lc = $('#list-comps');
	lc.innerHTML = '';
	(App.plan.components || []).forEach(c => {
		const d = document.createElement('div');
		d.textContent = `${c.ref}  ${c.value || ''}  ${c.symbolKey ? ('[' + c.symbolKey + ']') : ''}`;
		lc.appendChild(d);
	});
	const ln = $('#list-nets');
	ln.innerHTML = '';
	(App.plan.nets || []).forEach(n => {
		const d = document.createElement('div');
		d.textContent = `${n.name}: ${(n.nodes || []).map(x => `${x.ref}-${x.pin}`).join(', ')}`;
		ln.appendChild(d);
	});
}

export function validatePlan() {
	const r = { unknownRefs: new Set(), emptyNets: [], dupRefs: [], totalNodes: 0 };
	const refSet = new Set();
	for (const c of (App.plan.components || [])) {
		if (refSet.has(c.ref)) r.dupRefs.push(c.ref);
		refSet.add(c.ref);
	}
	for (const net of (App.plan.nets || [])) {
		const nodes = (net.nodes || []).filter(Boolean);
		if (!nodes.length) r.emptyNets.push(net.name);
		r.totalNodes += nodes.length;
		nodes.forEach(nd => {
			if (!refSet.has(nd.ref)) r.unknownRefs.add(nd.ref);
		});
	}
	return r;
}

export function showValidation(r) {
	if (r.dupRefs.length || r.unknownRefs.size || r.emptyNets.length) {
		const msg = [
			r.dupRefs.length ? `重复器件: ${[...new Set(r.dupRefs)].join(', ')}` : '',
			r.unknownRefs.size ? `未定义器件: ${[...r.unknownRefs].join(', ')}` : '',
			r.emptyNets.length ? `空网络: ${r.emptyNets.join(', ')}` : ''
		].filter(Boolean).join('； ');
		toast('网表导入成功，但存在问题：' + msg, 'warn', 4200);
	} else {
		toast(`网表导入成功：${App.plan.components.length} 个器件，${App.plan.nets.length} 条网络`, 'ok');
	}
}


