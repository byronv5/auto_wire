/* 全局常量、状态与基础工具 */

export const GRID = 10, WIRE_WIDTH = 2;
export const DEFAULT_VB = { x: 0, y: 0, w: 2400, h: 1600 };
export const PLACEMENT_MARGIN = 12;
export const POWER_TRI_W = 12, POWER_TRI_H = 12, GND_W = 20, GND_H = 14;
export const POWER_LEAD = 12;

/* 簇级布局参数 */
export const CLUSTER_PADDING = 60;  // 簇内边距
export const CLUSTER_GAP = 80;       // 簇间间隙
export const CLUSTER_SLOT = 360;     // 簇布局半径（减小半径以使模块更靠近）
export const PORT_AXIS_BIAS = 0.85;  // 投影方向偏置（保留给后续算法）

/* 被动贴芯细化参数 */
export const DIRECT_PAIR_GAP_BONUS = 10; // 被动与IC构成二节点网络时贴近量

/* A* 代价权重（已调优） */
export const ASTAR_WEIGHTS = {
	step: 1,
	bend: 8,
	nearWire: 3,
	crossWire: 25,
	crossSameNet: 4,
	otherAxisPenalty: 0.15
};

/* 默认参数 - 根据用户优化设置 */
export const ParamsDefault = {
	// 电源引线参数
	powerStub: 24,      // 非IC引线长度
	powerStubIC: 32,    // IC引线长度

	// 被动元件贴芯参数
	beltGap: 40,        // 被动元件距芯片距离
	beltStep: 16,       // 腰带步距

	// 逃逸路径参数
	escape: 40,         // 逃逸线长度

	// 路由避让参数
	clear: 14,          // 路由避让膨胀

	// 搜索限制参数
	time: 400,          // BFS时间上限
	visits: 250000,     // BFS访问上限

	// 布局微调参数
	nudgeInitial: 6,    // 微调初始步长
	nudgeIncrement: 6,  // 微调增量
	nudgeMaxAttempts: 7,// 最大微调次数

	// 导线长度限制
	maxWireLength: 1600,// 最长导线阈值
};

export let Params = JSON.parse(JSON.stringify(ParamsDefault));

/* App状态容器 */
export const App = {
	lib: new Map(),
	libNorm: new Map(),
	plan: { components: [], nets: [] },
	inst: [],
	wires: [],
	netLabels: [],
	powerObstacles: [],
	cam: { ...DEFAULT_VB },
	stats: { totalNets: 0, wiredNets: 0, labeledNets: 0 },
	pinNetMap: new Map(),
	passiveToPrimaryIC: new Map(),
	clusters: [],
	compToCluster: new Map(),
	clusterGraph: new Map()
};

/* DOM/工具 */
export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];
export const uuid = () => ('id_' + Math.random().toString(36).slice(2, 9));
export const snap = v => (Math.round(v / GRID) * GRID);

export function toast(msg, type = 'ok', timeout = 2600) {
	const box = $('#toasts');
	const d = document.createElement('div');
	d.className = 'toast ' + (type === 'err' ? 'err' : type === 'warn' ? 'warn' : 'ok');
	d.textContent = msg;
	box.appendChild(d);
	setTimeout(() => { d.style.opacity = '0'; }, timeout);
	setTimeout(() => { box.removeChild(d); }, timeout + 360);
}

/* 文本归一化与别名规则（供库匹配与搜索） */
export function norm(s) {
	return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

export function aliasNorms(s) {
	const n = norm(s);
	const S = new Set([n]);
	if (n.startsWith('at')) S.add(n.slice(2));
	if (n.endsWith('a')) S.add(n.slice(0, -1));
	if (/^(hdr1x)(\d+)$/.test(n)) S.add('header' + RegExp.$2);
	if (/^header(\d+)$/.test(n)) S.add('hdr1x' + RegExp.$1);
	if (n.includes('uln2003')) S.add('uln2003');
	if (n.includes('89c51')) { S.add('89c51'); S.add('at89c51'); }
	if (n.includes('hc49s')) S.add('crystal');
	if (n.includes('component1')) { S.add('component_1'); }
	if (n.includes('component_1')) { S.add('component1'); }
	if (n.includes('step') && n.includes('motor')) { S.add('hdr1x5'); S.add('header5'); }
	return [...S];
}


