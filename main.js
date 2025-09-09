import { initializeApp } from './interaction.js';
import { toast } from './utils.js';
import { schdocSync } from './schdocSync.js';
import { importNetlistFromText } from './fileHandlers.js';
import { buildInstances, renderInstances, clearCanvas } from './component.js';
import { PlacementEngine } from './placement.js';
import { routeAllNets } from './routing.js';
import { DEFAULT_VB } from './config.js';
import { App } from './state.js';

// 页面加载完成后初始化
window.addEventListener('DOMContentLoaded', () => {
  initializeApp();
  toast('工具已就绪 V2.33 - 复位电路优化版 + schdoc导出', 'ok');
  console.log('原理图自动生成工具 V2.33');
  console.log('主要优化：');
  console.log('- 修复复位电路R/C分离问题');
  console.log('- 将R1和C1作为整体优先放置');
  console.log('- 增加邻近放置辅助函数');
  console.log('- 保留原有的去耦电容优化');
  console.log('- 新增schdoc实时导出功能');
  
  // schdoc同步功能始终启用
  console.log('schdoc实时同步已启用');
  toast('schdoc实时同步已启用', 'ok');

  // 暴露自动化API，供无头浏览器调用
  window.autoAPI = {
    importNetlist: (text) => {
      importNetlistFromText(text);
    },
    placeAndRoute: () => {
      if (!App.plan?.components?.length) {
        throw new Error('请先导入网表');
      }
      clearCanvas();
      buildInstances();
      const FIXED_SEED = 12345;
      const engine = new PlacementEngine(App.inst, App.plan, DEFAULT_VB.w, DEFAULT_VB.h, FIXED_SEED);
      App.currentPlacementEngine = engine;
      engine.runHierarchicalLayout();
      renderInstances();
      routeAllNets();
      return {
        instances: App.inst.length,
        wires: App.wires.length
      };
    },
    exportSchdoc: async (filename = 'schematic.schdoc') => {
      const content = await schdocSync.exportSchdoc(filename);
      return content;
    }
  };
});