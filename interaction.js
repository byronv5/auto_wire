import { App } from './state.js';
import { $, snap, toast } from './utils.js';
import { DEFAULT_VB } from './config.js';
import { enablePanZoom } from './view.js';
import { loadLibFiles, importNetlistFile, importNetlistFromText, tryParseJSON, parseProtelNET } from './fileHandlers.js';
import { libCount } from './symbol.js';
import { clearCanvas, buildInstances, renderInstances, instTransform } from './component.js';
import { routeAllNets } from './routing.js';
import { PlacementEngine } from './placement.js';

/* ===== 元件交互与初始化 ===== */
function enableComponentInteraction() {
  const svg = $('#schematic');
  let isDragging = false;
  let dragStart = { x: 0, y: 0 };
  let instStart = { x: 0, y: 0 };

  svg.addEventListener('mousedown', e => {
    if (e.button !== 0) return;

    const symbolEl = e.target.closest('.symbol');
    if (symbolEl) {
      e.stopPropagation();

      if (App.selectedInst) {
        const prevEl = $(`[data-id="${App.selectedInst.id}"]`);
        if (prevEl) prevEl.classList.remove('selected');
      }

      const instId = symbolEl.getAttribute('data-id');
      App.selectedInst = App.inst.find(i => i.id === instId);
      
      if (App.selectedInst) {
        symbolEl.classList.add('selected');
        isDragging = true;
        dragStart = { x: e.clientX, y: e.clientY };
        instStart = { x: App.selectedInst.x, y: App.selectedInst.y };
      }
    } else {
        if (App.selectedInst) {
            const prevEl = $(`[data-id="${App.selectedInst.id}"]`);
            if (prevEl) prevEl.classList.remove('selected');
            App.selectedInst = null;
        }
    }
  });

  window.addEventListener('mousemove', e => {
    if (!isDragging || !App.selectedInst) return;
    
    const r = svg.getBoundingClientRect();
    const dx = (e.clientX - dragStart.x) / r.width * App.cam.w;
    const dy = (e.clientY - dragStart.y) / r.height * App.cam.h;

    App.selectedInst.x = instStart.x + dx;
    App.selectedInst.y = instStart.y + dy;

    const el = $(`[data-id="${App.selectedInst.id}"]`);
    if (el) {
      el.setAttribute('transform', instTransform(App.selectedInst));
    }
  });

  window.addEventListener('mouseup', () => {
    if (isDragging && App.selectedInst) {
      isDragging = false;
      App.selectedInst.x = snap(App.selectedInst.x);
      App.selectedInst.y = snap(App.selectedInst.y);
      
      renderInstances();
      const currentSelectedEl = $(`[data-id="${App.selectedInst.id}"]`);
      if (currentSelectedEl) currentSelectedEl.classList.add('selected');
      
      if(App.wires.length > 0) {
        routeAllNets();
        toast('元件已移动，自动重新布线', 'ok');
      }
    }
  });

  window.addEventListener('keydown', e => {
    if (e.code === 'Space' && App.selectedInst) {
      e.preventDefault();
      App.selectedInst.rot = (App.selectedInst.rot + 90) % 360;
      
      renderInstances();
      const currentSelectedEl = $(`[data-id="${App.selectedInst.id}"]`);
      if (currentSelectedEl) currentSelectedEl.classList.add('selected');

      if(App.wires.length > 0) {
        routeAllNets();
        toast('元件已旋转，自动重新布线', 'ok');
      }
    }
  });
}

export function initializeApp() {
  enablePanZoom();
  enableComponentInteraction();
  
  $('#lib-input').onchange = async (e) => {
    const files = e.target.files;
    if (files && files.length) {
      await loadLibFiles([...files]);
    }
  };
  
  $('#btn-import-netlist').onclick = () => {
    importNetlistFile();
  };
  
  $('#btn-export-netlist').onclick = () => {
    const jsonStr = JSON.stringify(App.plan, null, 2);
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'netlist.json';
    a.click();
    URL.revokeObjectURL(url);
    toast('网表已导出', 'ok');
  };
  
  $('#btn-export-svg').onclick = () => {
    const svg = $('#schematic');
    const svgStr = new XMLSerializer().serializeToString(svg);
    const blob = new Blob([svgStr], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'schematic.svg';
    a.click();
    URL.revokeObjectURL(url);
    toast('原理图已导出', 'ok');
  };
  
// ... (函数内其他代码保持不变) ...
  $('#btn-place-route').onclick = () => {
    if (!App.plan.components?.length) {
      toast('请先导入网表', 'warn');
      return;
    }
    if (libCount() === 0) {
      toast('请先导入符号库', 'warn');
      return;
    }
    
    clearCanvas();
    buildInstances();
    
    // 使用固定种子，确保每次布局一致
    const FIXED_SEED = 12345;
    const engine = new PlacementEngine(App.inst, App.plan, DEFAULT_VB.w, DEFAULT_VB.h, FIXED_SEED);
    engine.runHierarchicalLayout();
    App.currentPlacementEngine = engine;
    renderInstances();
    routeAllNets();
    
    toast(`布局布线完成：${App.inst.length}个器件，${App.wires.length}条连线`, 'ok');
  };
// ... (函数内其他代码保持不变) ...
  
  $('#btn-reroute').onclick = () => {
    if (!App.inst.length) {
      toast('画布为空，请先执行布局布线', 'warn');
      return;
    }
    
    // 使用固定种子，确保每次布局一致
    const FIXED_SEED = 12345;
    const engine = new PlacementEngine(App.inst, App.plan, DEFAULT_VB.w, DEFAULT_VB.h, FIXED_SEED);
    engine.runHierarchicalLayout();
    
    renderInstances();
    routeAllNets();
    toast('重新布局布线完成', 'ok');
  };
  
  $('#btn-clear').onclick = () => {
    clearCanvas();
  };
  
  $('#ck-grid').onchange = (e) => {
    $('#g-grid').style.display = e.target.checked ? 'block' : 'none';
  };
  
  $('#netlist-text').addEventListener('input', (e) => {
    const txt = e.target.value.trim();
    if (txt.length > 50) {
      try {
        const plan = tryParseJSON(txt) || parseProtelNET(txt);
        if (plan && plan.components && plan.nets) {
          // 不自动导入
        }
      } catch {}
    }
  });
  
  $('#netlist-text').addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.ctrlKey) {
      const txt = e.target.value.trim();
      if (txt) {
        importNetlistFromText(txt);
      }
    }
  });
}