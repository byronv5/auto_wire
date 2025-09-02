import { App } from './state.js';
import { $ } from './utils.js';

/* ===== 质量指示器 ===== */
export function updateQualityIndicator() {
  const report = App.qualityReport;
  if (!report) return;
  
  const indicator = $('#quality-indicator');
  const text = $('#quality-text');
  
  let quality = 'excellent';
  let label = '优秀';
  
  if (report.criticals.length > 0) {
    quality = 'poor';
    label = '需改进';
  } else if (report.warnings.length > 5) {
    quality = 'warning';
    label = '一般';
  } else if (report.warnings.length > 0) {
    quality = 'good';
    label = '良好';
  }
  
  indicator.className = 'quality-indicator ' + quality;
  text.textContent = label;
  indicator.style.display = 'inline-flex';
  
  const reportCard = $('#quality-report');
  const details = $('#quality-details');
  
  if (report.criticals.length > 0 || report.warnings.length > 0) {
    let html = '';
    if (report.criticals.length > 0) {
      html += '<div style="color:var(--danger);font-weight:600">严重问题:</div>';
      html += '<ul style="margin:4px 0;padding-left:20px">';
      report.criticals.forEach(msg => {
        html += `<li>${msg}</li>`;
      });
      html += '</ul>';
    }
    if (report.warnings.length > 0) {
      html += '<div style="color:var(--warn);font-weight:600">警告:</div>';
      html += '<ul style="margin:4px 0;padding-left:20px">';
      report.warnings.slice(0, 5).forEach(msg => {
        html += `<li>${msg}</li>`;
      });
      if (report.warnings.length > 5) {
        html += `<li>... 还有 ${report.warnings.length - 5} 个警告</li>`;
      }
      html += '</ul>';
    }
    details.innerHTML = html;
    reportCard.style.display = 'flex';
  } else {
    reportCard.style.display = 'none';
  }
}