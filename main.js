import { initializeApp } from './interaction.js';
import { toast } from './utils.js';

// 页面加载完成后初始化
window.addEventListener('DOMContentLoaded', () => {
  initializeApp();
  toast('工具已就绪 V2.33 - 复位电路优化版', 'ok');
  console.log('原理图自动生成工具 V2.33');
  console.log('主要优化：');
  console.log('- 修复复位电路R/C分离问题');
  console.log('- 将R1和C1作为整体优先放置');
  console.log('- 增加邻近放置辅助函数');
  console.log('- 保留原有的去耦电容优化');
});