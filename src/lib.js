import { App, Params, $, aliasNorms, norm } from './state.js';

function addToMapList(map, key, rec) {
	if (!key) return;
	const arr = map.get(key) || [];
	arr.push(rec);
	map.set(key, arr);
}

function allDistinctRecs() {
	const set = new Set();
	for (const arr of App.lib.values()) arr.forEach(r => set.add(r));
	return [...set];
}

export function libCount() {
	return allDistinctRecs().length;
}

// 读取svg_lib文件夹中的SVG文件
export async function loadSvgLib() {
	let ok = 0, fail = 0;
	
	try {
		// 尝试获取svg_lib文件夹的目录列表
		let svgFiles = [];
		
		// 方法1: 尝试通过服务器目录列表获取文件
		console.log('尝试读取svg_lib目录...');
		try {
			const response = await fetch('./svg_lib/');
			console.log('目录请求状态:', response.status, response.statusText);
			console.log('目录请求URL:', response.url);
			
			if (response.ok) {
				const html = await response.text();
				console.log('成功获取目录内容，长度:', html.length);
				// 解析HTML目录页面，提取SVG文件
				const parser = new DOMParser();
				const doc = parser.parseFromString(html, 'text/html');
				const links = doc.querySelectorAll('a[href$=".svg"]');
				svgFiles = Array.from(links).map(a => a.href.split('/').pop());
				console.log('从目录解析到的SVG文件:', svgFiles);
			} else {
				console.log('目录请求失败，状态码:', response.status);
			}
		} catch (e) {
			console.log('目录请求异常:', e.message);
		}
		
		// 方法2: 如果目录列表失败，尝试通过index.html或类似文件获取
		if (svgFiles.length === 0) {
			console.log('尝试读取index.html...');
			try {
				const response = await fetch('./svg_lib/index.html');
				console.log('index.html请求状态:', response.status, response.statusText);
				
				if (response.ok) {
					const html = await response.text();
					console.log('成功获取index.html，长度:', html.length);
					const parser = new DOMParser();
					const doc = parser.parseFromString(html, 'text/html');
					const links = doc.querySelectorAll('a[href$=".svg"]');
					svgFiles = Array.from(links).map(a => a.href.split('/').pop());
					console.log('从index.html解析到的SVG文件:', svgFiles);
				} else {
					console.log('index.html请求失败，状态码:', response.status);
				}
			} catch (e) {
				console.log('index.html请求异常:', e.message);
			}
		}
		
		// 方法3: 如果以上都失败，使用预定义列表作为后备方案
		if (svgFiles.length === 0) {
			console.warn('无法动态获取文件列表，使用预定义列表作为后备方案');
			svgFiles = [
				'89c51.svg', 'C1.svg', 'C2.svg', 'C3.svg', 'C4.svg',
				'D1.svg', 'D2.svg', 'D3.svg', 'NEGETIVE.svg', 'POSITIVE.svg',
				'POWER-2P.svg', 'R1.svg', 'R10.svg', 'R2.svg', 'R3.svg',
				'STEP-MOTOR.svg', 'U1.svg', 'U2.svg', 'X1.svg'
			];
		}
		
		console.log(`最终将处理 ${svgFiles.length} 个SVG文件:`, svgFiles);
		
		// 处理每个SVG文件
		for (const fileName of svgFiles) {
			try {
				console.log(`正在处理文件: ${fileName}`);
				const response = await fetch(`./svg_lib/${fileName}`);
				if (!response.ok) {
					console.warn(`无法加载文件: ${fileName}, 状态: ${response.status}`);
					fail++;
					continue;
				}
				
				const txt = await response.text();
				const dp = new DOMParser();
				const doc = dp.parseFromString(txt, 'image/svg+xml');
				const svgEl = doc.querySelector('svg');
				if (!svgEl) { 
					console.warn(`文件不是有效的SVG: ${fileName}`);
					fail++; 
					continue; 
				}

				let vb = (svgEl.getAttribute('viewBox') || '').trim();
				let w = 0, h = 0, vx = 0, vy = 0;
				if (vb) {
					const p = vb.split(/\s+/).map(Number);
					vx = p[0] || 0; vy = p[1] || 0; w = p[2]; h = p[3];
				}
				else {
					const ww = parseFloat((svgEl.getAttribute('width') || '100').replace(/px$/i, ''));
					const hh = parseFloat((svgEl.getAttribute('height') || '60').replace(/px$/i, ''));
					w = ww || 100; h = hh || 60;
					vb = `0 0 ${w} ${h}`;
				}

				let pins = [];
				const metaEl = doc.querySelector('metadata#eda-meta');
				if (metaEl) {
					try {
						const meta = JSON.parse(metaEl.textContent.trim());
						if (Array.isArray(meta?.component?.pins)) {
							pins = meta.component.pins.map(p => ({
								number: String(p.number ?? p.display_number ?? ''),
								name: String(p.name ?? ''),
								x: Number(p.x) - vx,
								y: Number(p.y) - vy
							})).filter(p => Number.isFinite(p.x) && Number.isFinite(p.y));
						}
					} catch { }
				}

				if (!pins.length) {
					const cps = [...doc.querySelectorAll('.connection-point,[role="connection-point"]')];
					pins = cps.map(cp => {
						const cx = Number(cp.getAttribute('data-x') || cp.querySelector('circle')?.getAttribute('cx') || NaN) - vx;
						const cy = Number(cp.getAttribute('data-y') || cp.querySelector('circle')?.getAttribute('cy') || NaN) - vy;
						return { number: String(cp.getAttribute('data-pin-number') || ''), name: String(cp.getAttribute('data-pin-name') || ''), x: cx, y: cy };
					}).filter(p => Number.isFinite(p.x) && Number.isFinite(p.y));
				}

				let key = fileName.replace(/\.[a-z0-9]+$/i, '');
				try {
					const meta = JSON.parse((doc.querySelector('metadata#eda-meta')?.textContent || '{}').trim());
					if (meta?.component?.lib_reference) key = String(meta.component.lib_reference);
				} catch { }

				const rec = { key, label: `${key} (${fileName})`, svgText: txt, viewBox: vb, w, h, pins: Array.isArray(pins) ? pins : [], fileBase: fileName.replace(/\.[a-z0-9]+$/i, '') };
				addToMapList(App.lib, key, rec);
				if (rec.fileBase !== key) addToMapList(App.lib, rec.fileBase, rec);
				aliasNorms(key).forEach(k => addToMapList(App.lib, k, rec));
				aliasNorms(rec.fileBase).forEach(k => addToMapList(App.lib, k, rec));
				ok++;
				console.log(`成功加载: ${fileName}`);
			} catch (e) {
				console.warn('解析库失败:', fileName, e);
				fail++;
			}
		}
	} catch (e) {
		console.warn('加载svg_lib失败:', e);
		fail++;
	}
	
	$('#lib-count').textContent = String(libCount());
	return { ok, fail };
}

export function collectCandidatesByKey(key) {
	if (!key) return [];
	const arr1 = App.lib.get(key) || [],
		arr2 = App.lib.get(key.toUpperCase()) || [],
		arr3 = App.lib.get(norm(key)) || [];
	const arr4 = aliasNorms(key).flatMap(k => App.lib.get(k) || []);
	return [...new Set([...arr1, ...arr2, ...arr3, ...arr4])];
}

export function collectCandidatesByValue(val) {
	if (!val) return [];
	const v = String(val);
	const arr = collectCandidatesByKey(v);
	if (arr.length) return arr;
	const pool = (function allDistinct() {
		const set = new Set();
		for (const arr of App.lib.values()) arr.forEach(r => set.add(r));
		return [...set];
	})();
	const nv = norm(v);
	return pool.filter(r => {
		const keys = [r.key, r.fileBase, ...aliasNorms(r.key), ...aliasNorms(r.fileBase)].map(norm);
		return keys.some(k => k.includes(nv) || nv.includes(k));
	});
}


