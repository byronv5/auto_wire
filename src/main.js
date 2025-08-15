import { App, $, toast } from './state.js';
import { enablePanZoom } from './view.js';
import { loadSvgLib } from './lib.js';
import { importNetlistFile, refreshPlanView } from './plan.js';
import { buildInstances } from './symbols.js';
import { createFunctionalClusters, placeAndRouteClusters } from './cluster.js';
import { assignPrimaryICs, placePassivesAroundICs, resolveClusterOverlaps } from './cluster_refine.js';
import { autoOrient } from './orient.js';
import { routeAllNets, abortRouting } from './routing/index.js';

function clearCanvas() {
	App.inst = [];
	App.wires = [];
	App.netLabels = [];
	App.powerObstacles = [];
	App.passiveToPrimaryIC?.clear?.();
	App.clusters = [];
	App.compToCluster = new Map();
	App.clusterGraph = new Map();
	$('#g-symbols').innerHTML = '';
	$('#g-wires').innerHTML = '';
	$('#g-junctions').innerHTML = '';
	$('#g-power-symbols').innerHTML = '';
	$('#g-nettags').innerHTML = '';
	$('#inst-count').textContent = '0';
	$('#wire-count').textContent = '0';
	$('#label-count').textContent = '0';
	$('#success-rate').textContent = '--';
	toast('画布已清空', 'ok');
}

async function runFullLayout() {
	abortRouting();
	if (!App.plan.components.length) { toast('请先导入网表', 'warn'); return; }
	const t0 = performance.now();
	toast('开始自动布局...', 'ok');
	$('#g-wires').innerHTML = '';
	$('#g-junctions').innerHTML = '';
	$('#g-nettags').innerHTML = '';
	$('#g-power-symbols').innerHTML = '';
	App.wires = []; App.netLabels = []; App.powerObstacles = [];
    buildInstances();
    createFunctionalClusters();
    placeAndRouteClusters();
    assignPrimaryICs();
    placePassivesAroundICs();
    autoOrient();
    resolveClusterOverlaps();
	toast('开始自动布线...', 'ok');
	await routeAllNets();
	toast(`全部流程完成，耗时 ${(performance.now() - t0 | 0)}ms`, 'ok');
}

function setupEventListeners() {
	$('#btn-import-netlist').onclick = () => { abortRouting(); importNetlistFile(); };
	$('#ck-grid').onchange = e => { $('#g-grid').style.display = e.target.checked ? 'block' : 'none'; };
	$('#btn-place-route').onclick = () => { runFullLayout(); };
	$('#btn-clear').onclick = () => {
		abortRouting();
		clearCanvas();
		App.plan = { components: [], nets: [] };
		refreshPlanView();
	};
}

async function init() {
	enablePanZoom();
	setupEventListeners();
	
	// 自动加载SVG库
	toast('正在加载SVG库...', 'ok');
	try {
		const { ok, fail } = await loadSvgLib();
		if (ok > 0) {
			toast(`SVG库加载完成：成功 ${ok} 个，失败 ${fail} 个`, 'ok');
		} else {
			toast('SVG库加载失败，请检查svg_lib文件夹', 'warn');
		}
	} catch (e) {
		console.error('加载SVG库时出错:', e);
		toast('加载SVG库时出错', 'warn');
	}
	
	toast('自动布线工具 V21.0（智能布局增强版）已就绪');
}

window.onload = init;


