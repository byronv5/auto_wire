import { App } from './state.js';
import { SCHDOC_CONFIG, GRID } from './config.js';

/**
 * schdoc元件库管理器
 * 负责加载和管理svglib目录中的schdoc文件
 */
export class SchdocLibrary {
  constructor() {
    this.library = new Map(); // 存储已加载的schdoc内容
    this.loadedComponents = new Set(); // 已加载的元件
  }

  /**
   * 加载单个元件的schdoc文件
   */
  async loadComponentSchdoc(componentKey) {
    if (this.library.has(componentKey)) {
      return this.library.get(componentKey);
    }

    try {
      const response = await fetch(`./svglib/${componentKey}.schdoc`);
      if (!response.ok) {
        console.warn(`无法加载 ${componentKey}.schdoc: ${response.status}`);
        return null;
      }
      
      const content = await response.text();
      const parsed = this.parseSchdocContent(content);
      
      this.library.set(componentKey, parsed);
      this.loadedComponents.add(componentKey);
      
      console.log(`已加载 ${componentKey}.schdoc`);
      return parsed;
    } catch (error) {
      console.error(`加载 ${componentKey}.schdoc 失败:`, error);
      return null;
    }
  }

  /**
   * 解析schdoc文件内容
   */
  parseSchdocContent(content) {
    const lines = content.split('\n').filter(line => line.trim());
    const records = [];
    
    for (const line of lines) {
      if (line.startsWith('|RECORD=')) {
        const normalizedLine = line.replace(/\r$/, '');
        const record = this.parseRecord(normalizedLine);
        if (record) {
          record.originalString = normalizedLine; // 保存去除\r的原始字符串
          records.push(record);
        }
      }
    }
    
    // 根据format.md规范分类记录
    return {
      allRecords: records, // 保持原始顺序的所有记录
      records,
      componentRecord: records.find(r => r.type === 1), // Component record
      pinRecords: records.filter(r => r.type === 2),   // Pin records
      // 图形记录：包括所有用于绘制元件图形的记录
      graphicRecords: records.filter(r => [
        3,  // IEEE Symbol
        5,  // Bezier
        6,  // Polyline (线条)
        7,  // Polygon
        8,  // Ellipse
        9,  // Piechart
        10, // Round rectangle
        11, // Elliptical arc
        12, // Arc
        13, // Line
        14  // Rectangle
      ].includes(r.type)),
      // 标签记录：包括所有文本标签
      labelRecords: records.filter(r => [
        4,  // Label (文本注释)
        34, // Designator (元件标号)
        41, // Parameter (参数标签)
        44  // Implementation list
      ].includes(r.type))
    };
  }

  /**
   * 解析单行记录
   */
  parseRecord(line) {
    const properties = {};
    const parts = line.split('|');
    
    for (const part of parts) {
      if (part.includes('=')) {
        const [key, value] = part.split('=', 2);
        properties[key] = value;
      }
    }
    
    return {
      type: parseInt(properties.RECORD) || 0,
      properties
    };
  }

  /**
   * 获取元件的schdoc模板
   */
  getComponentTemplate(componentKey) {
    return this.library.get(componentKey);
  }

  /**
   * 批量加载所有元件的schdoc文件
   */
  async loadAllComponentSchdocs() {
    const componentKeys = new Set();
    
    // 从当前实例中收集所有元件类型（使用ref而不是symbol.key）
    App.inst.forEach(inst => {
      if (inst.ref) {
        componentKeys.add(inst.ref);
      }
    });
    
    // 并行加载所有schdoc文件
    const loadPromises = Array.from(componentKeys).map(key => 
      this.loadComponentSchdoc(key)
    );
    
    await Promise.all(loadPromises);
    
    console.log(`已加载 ${this.library.size} 个元件的schdoc文件`);
    return this.library.size;
  }

  /**
   * 基于schdoc模板创建元件记录
   */
  createComponentFromTemplate(inst, template) {
    if (!template || !template.componentRecord) {
      return this.createFallbackComponent(inst);
    }

    const componentRecord = template.componentRecord;
    // 优先使用“引脚质心对齐”，更贴合连线
    const potCenter = this.isHorizontalPotInst(inst) ? this.getCanvasPotMidlineCenterSch(inst) : null;
    const pinsCenterCanvas = potCenter || this.getCanvasPinsCenterSch(inst);
    const center = pinsCenterCanvas || this.convertCenterFloat(inst.x + (inst.symbol?.w||0)/2, inst.y + (inst.symbol?.h||0)/2);
    const coords = { x: Math.round(center.x), y: Math.round(center.y) };
    // 与 Canvas 器件中心对齐：以模板图形中心为锚点
    const { ax, ay } = this.getTemplateAnchorTopLeft(template);
    // 可选微调：根据引脚与导线的最近距离
    const fine = (SCHDOC_CONFIG.AUTO_FINE_ALIGN ? this.computeFineAlignDelta(inst) : { dx: 0, dy: 0 });
    const fineDelta = this.convertDelta(fine.dx, fine.dy);
    const bias = this.applyBiasForLib(inst?.ref || inst?.symbol?.key);
    let deltaX = coords.x - ax + (SCHDOC_CONFIG.COMPONENT_OFFSET_X || 0) + fineDelta.dx + bias.dx;
    let deltaY = coords.y - ay + (SCHDOC_CONFIG.COMPONENT_OFFSET_Y || 0) + fineDelta.dy + bias.dy;
    ({ dx: deltaX, dy: deltaY } = this.snapDelta(deltaX, deltaY));
    try { console.log('[Schdoc] createComponentFromTemplate', inst?.ref, {coords, anchorX: ax, anchorY: ay, deltaX, deltaY}); } catch(_) {}
    
    // 直接使用模板的原始字符串，只替换需要替换的参数值
    let recordString = (componentRecord.originalString || this.buildRecordString(componentRecord.properties)).replace(/\r/g, '');
    
    // 组件记录使用：模板原值 + delta（保持与其余记录同一平移）
    const baseCompX = parseInt(componentRecord.properties['LOCATION.X'] || 0);
    const baseCompY = parseInt(componentRecord.properties['LOCATION.Y'] || 0);
    const compNewX = baseCompX + deltaX;
    const compNewY = baseCompY + deltaY;
    recordString = recordString.replace(/LOCATION\.X=-?\d+/, `LOCATION.X=${compNewX}`);
    recordString = recordString.replace(/LOCATION\.Y=-?\d+/, `LOCATION.Y=${compNewY}`);
    
    // 替换UNIQUEID
    const newUniqueId = this.generateUniqueId();
    recordString = recordString.replace(/UNIQUEID=[^|]+/, `UNIQUEID=${newUniqueId}`);
    
    // 若组件记录内包含其他坐标（极少见），也应用平移
    recordString = this.applyDeltaToRecordString(recordString, componentRecord.properties, deltaX, deltaY);
    return recordString;
  }

  /**
   * 基于schdoc模板创建引脚记录
   */
  createPinsFromTemplate(inst, template, ownerIndex) {
    if (!template || !template.pinRecords) {
      return this.createFallbackPins(inst, ownerIndex);
    }

    return template.pinRecords.map(pinRecord => {
      const potCenter = this.isHorizontalPotInst(inst) ? this.getCanvasPotMidlineCenterSch(inst) : null;
      const pinsCenterCanvas = potCenter || this.getCanvasPinsCenterSch(inst);
      const center = pinsCenterCanvas || this.convertCenterFloat(inst.x + (inst.symbol?.w||0)/2, inst.y + (inst.symbol?.h||0)/2);
      const coords = { x: Math.round(center.x), y: Math.round(center.y) };
      const { ax, ay } = this.getTemplateAnchorTopLeft(template);
      const fine = (SCHDOC_CONFIG.AUTO_FINE_ALIGN ? this.computeFineAlignDelta(inst) : { dx: 0, dy: 0 });
      const fineDelta = this.convertDelta(fine.dx, fine.dy);
      const bias = this.applyBiasForLib(inst?.ref || inst?.symbol?.key);
      let deltaX = coords.x - ax + (SCHDOC_CONFIG.COMPONENT_OFFSET_X || 0) + fineDelta.dx + bias.dx;
      let deltaY = coords.y - ay + (SCHDOC_CONFIG.COMPONENT_OFFSET_Y || 0) + fineDelta.dy + bias.dy;
      ({ dx: deltaX, dy: deltaY } = this.snapDelta(deltaX, deltaY));
      try { console.log('[Schdoc] createPinsFromTemplate', inst?.ref, {coords, anchorX: ax, anchorY: ay, deltaX, deltaY}); } catch(_) {}
      
      // 直接使用模板的原始字符串，只替换需要替换的参数值
      let recordString = (pinRecord.originalString || this.buildRecordString(pinRecord.properties)).replace(/\r/g, '');
      
      // 替换OWNERINDEX
      recordString = recordString.replace(/OWNERINDEX=\d+/, `OWNERINDEX=${ownerIndex}`);
      
      // 通过平移（相对于模板基准）计算绝对坐标
      const locationX = parseInt(pinRecord.properties['LOCATION.X'] || 0) + deltaX;
      const locationY = parseInt(pinRecord.properties['LOCATION.Y'] || 0) + deltaY;
      recordString = recordString.replace(/LOCATION\.X=-?\d+/, `LOCATION.X=${locationX}`);
      recordString = recordString.replace(/LOCATION\.Y=-?\d+/, `LOCATION.Y=${locationY}`);
      
      // 替换UNIQUEID
      const newUniqueId = this.generateUniqueId();
      recordString = recordString.replace(/UNIQUEID=[^|]+/, `UNIQUEID=${newUniqueId}`);
      
      // 处理可能出现的其它坐标键（安全起见）
      recordString = this.applyDeltaToRecordString(recordString, pinRecord.properties, deltaX, deltaY);
      return recordString;
    });
  }

  /**
   * 基于schdoc模板创建图形记录
   */
  createGraphicsFromTemplate(inst, template, ownerIndex) {
    if (!template || !template.graphicRecords) {
      return [];
    }

    return template.graphicRecords.map(graphicRecord => {
      const potCenter = this.isHorizontalPotInst(inst) ? this.getCanvasPotMidlineCenterSch(inst) : null;
      const pinsCenterCanvas = potCenter || this.getCanvasPinsCenterSch(inst);
      const center = pinsCenterCanvas || this.convertCenterFloat(inst.x + (inst.symbol?.w||0)/2, inst.y + (inst.symbol?.h||0)/2);
      const coords = { x: Math.round(center.x), y: Math.round(center.y) };
      const { ax, ay } = this.getTemplateAnchorTopLeft(template);
      const fine = (SCHDOC_CONFIG.AUTO_FINE_ALIGN ? this.computeFineAlignDelta(inst) : { dx: 0, dy: 0 });
      const fineDelta = this.convertDelta(fine.dx, fine.dy);
      const bias = this.applyBiasForLib(inst?.ref || inst?.symbol?.key);
      let deltaX = coords.x - ax + (SCHDOC_CONFIG.COMPONENT_OFFSET_X || 0) + fineDelta.dx + bias.dx;
      let deltaY = coords.y - ay + (SCHDOC_CONFIG.COMPONENT_OFFSET_Y || 0) + fineDelta.dy + bias.dy;
      ({ dx: deltaX, dy: deltaY } = this.snapDelta(deltaX, deltaY));
      try { console.log('[Schdoc] createGraphicsFromTemplate', inst?.ref, {coords, anchorX: ax, anchorY: ay, deltaX, deltaY}); } catch(_) {}
      
      // 直接使用模板的原始字符串，只替换需要替换的参数值
      let recordString = (graphicRecord.originalString || this.buildRecordString(graphicRecord.properties)).replace(/\r/g, '');
      
      // 替换OWNERINDEX
      recordString = recordString.replace(/OWNERINDEX=\d+/, `OWNERINDEX=${ownerIndex}`);
      
      // 平移所有坐标
      const locationX = parseInt(graphicRecord.properties['LOCATION.X'] || 0) + deltaX;
      const locationY = parseInt(graphicRecord.properties['LOCATION.Y'] || 0) + deltaY;
      recordString = recordString.replace(/LOCATION\.X=-?\d+/, `LOCATION.X=${locationX}`);
      recordString = recordString.replace(/LOCATION\.Y=-?\d+/, `LOCATION.Y=${locationY}`);
      
      // 若存在矩形或圆角矩形等使用的CORNER坐标，则一并偏移
      if (graphicRecord.properties['CORNER.X'] !== undefined) {
        const cornerX = parseInt(graphicRecord.properties['CORNER.X'] || 0) + deltaX;
        recordString = recordString.replace(/CORNER\.X=-?\d+/, `CORNER.X=${cornerX}`);
      }
      if (graphicRecord.properties['CORNER.Y'] !== undefined) {
        const cornerY = parseInt(graphicRecord.properties['CORNER.Y'] || 0) + deltaY;
        recordString = recordString.replace(/CORNER\.Y=-?\d+/, `CORNER.Y=${cornerY}`);
      }
      
      // 多点坐标（如多段线/多边形：X1,Y1...）整体平移
      recordString = this.applyDeltaToRecordString(recordString, graphicRecord.properties, deltaX, deltaY);
      
      // 替换UNIQUEID
      const newUniqueId = this.generateUniqueId();
      recordString = recordString.replace(/UNIQUEID=[^|]+/, `UNIQUEID=${newUniqueId}`);
      
      return recordString;
    });
  }

  /**
   * 基于schdoc模板创建标签记录
   */
  createLabelsFromTemplate(inst, template, ownerIndex) {
    if (!template || !template.labelRecords) {
      return [];
    }

    return template.labelRecords.map(labelRecord => {
      const potCenter = this.isHorizontalPotInst(inst) ? this.getCanvasPotMidlineCenterSch(inst) : null;
      const pinsCenterCanvas = potCenter || this.getCanvasPinsCenterSch(inst);
      const center = pinsCenterCanvas || this.convertCenterFloat(inst.x + (inst.symbol?.w||0)/2, inst.y + (inst.symbol?.h||0)/2);
      const coords = { x: Math.round(center.x), y: Math.round(center.y) };
      const { ax, ay } = this.getTemplateAnchorTopLeft(template);
      const fine = (SCHDOC_CONFIG.AUTO_FINE_ALIGN ? this.computeFineAlignDelta(inst) : { dx: 0, dy: 0 });
      const fineDelta = this.convertDelta(fine.dx, fine.dy);
      const bias = this.applyBiasForLib(inst?.ref || inst?.symbol?.key);
      let deltaX = coords.x - ax + (SCHDOC_CONFIG.COMPONENT_OFFSET_X || 0) + fineDelta.dx + bias.dx;
      let deltaY = coords.y - ay + (SCHDOC_CONFIG.COMPONENT_OFFSET_Y || 0) + fineDelta.dy + bias.dy;
      ({ dx: deltaX, dy: deltaY } = this.snapDelta(deltaX, deltaY));
      try { console.log('[Schdoc] createLabelsFromTemplate', inst?.ref, {coords, anchorX: ax, anchorY: ay, deltaX, deltaY}); } catch(_) {}
      
      // 直接使用模板的原始字符串，只替换需要替换的参数值
      let recordString = (labelRecord.originalString || this.buildRecordString(labelRecord.properties)).replace(/\r/g, '');
      
      // 替换OWNERINDEX
      recordString = recordString.replace(/OWNERINDEX=\d+/, `OWNERINDEX=${ownerIndex}`);
      
      // 平移坐标
      const locationX = parseInt(labelRecord.properties['LOCATION.X'] || 0) + deltaX;
      const locationY = parseInt(labelRecord.properties['LOCATION.Y'] || 0) + deltaY;
      recordString = recordString.replace(/LOCATION\.X=-?\d+/, `LOCATION.X=${locationX}`);
      recordString = recordString.replace(/LOCATION\.Y=-?\d+/, `LOCATION.Y=${locationY}`);
      
      // 替换UNIQUEID
      const newUniqueId = this.generateUniqueId();
      recordString = recordString.replace(/UNIQUEID=[^|]+/, `UNIQUEID=${newUniqueId}`);
      
      recordString = this.applyDeltaToRecordString(recordString, labelRecord.properties, deltaX, deltaY);
      return recordString;
    });
  }

  /**
   * 按照模板原始顺序创建所有记录
   */
  createAllRecordsFromTemplate(inst, template, ownerIndex) {
    const potCenter = this.isHorizontalPotInst(inst) ? this.getCanvasPotMidlineCenterSch(inst) : null;
    const pinsCenterCanvas = potCenter || this.getCanvasPinsCenterSch(inst);
    const center = pinsCenterCanvas || this.convertCenterFloat(inst.x + (inst.symbol?.w||0)/2, inst.y + (inst.symbol?.h||0)/2);
    const coords = { x: Math.round(center.x), y: Math.round(center.y) };
    const allRecords = [];
    
    // 按照模板的原始顺序处理所有记录：以锚点左上角为对齐基准
    const { ax, ay } = this.getTemplateAnchorTopLeft(template);
    const fine = (SCHDOC_CONFIG.AUTO_FINE_ALIGN ? this.computeFineAlignDelta(inst) : { dx: 0, dy: 0 });
    const fineDelta = this.convertDelta(fine.dx, fine.dy);
    const bias = this.applyBiasForLib(inst?.ref || inst?.symbol?.key);
    let deltaX = coords.x - ax + (SCHDOC_CONFIG.COMPONENT_OFFSET_X || 0) + fineDelta.dx + bias.dx;
    let deltaY = coords.y - ay + (SCHDOC_CONFIG.COMPONENT_OFFSET_Y || 0) + fineDelta.dy + bias.dy;
    ({ dx: deltaX, dy: deltaY } = this.snapDelta(deltaX, deltaY));
    try { console.log('[Schdoc] createAllRecordsFromTemplate', inst?.ref, {coords, anchorX: ax, anchorY: ay, deltaX, deltaY}); } catch(_) {}

    template.allRecords.forEach(record => {
      let recordString = (record.originalString || this.buildRecordString(record.properties)).replace(/\r/g, '');
      
      // 替换OWNERINDEX
      recordString = recordString.replace(/OWNERINDEX=\d+/, `OWNERINDEX=${ownerIndex}`);
      
      // 平移坐标（相对模板基准）
      const locationX = parseInt(record.properties['LOCATION.X'] || 0) + deltaX;
      const locationY = parseInt(record.properties['LOCATION.Y'] || 0) + deltaY;
      recordString = recordString.replace(/LOCATION\.X=-?\d+/, `LOCATION.X=${locationX}`);
      recordString = recordString.replace(/LOCATION\.Y=-?\d+/, `LOCATION.Y=${locationY}`);

      // 处理矩形/圆角矩形等的CORNER坐标
      if (record.properties['CORNER.X'] !== undefined) {
        const cornerX = parseInt(record.properties['CORNER.X'] || 0) + deltaX;
        recordString = recordString.replace(/CORNER\.X=-?\d+/, `CORNER.X=${cornerX}`);
      }
      if (record.properties['CORNER.Y'] !== undefined) {
        const cornerY = parseInt(record.properties['CORNER.Y'] || 0) + deltaY;
        recordString = recordString.replace(/CORNER\.Y=-?\d+/, `CORNER.Y=${cornerY}`);
      }
      
      // 处理多点坐标（X1,Y1...）的整体偏移
      recordString = this.applyDeltaToRecordString(recordString, record.properties, deltaX, deltaY);
      
      // 替换UNIQUEID
      const newUniqueId = this.generateUniqueId();
      recordString = recordString.replace(/UNIQUEID=[^|]+/, `UNIQUEID=${newUniqueId}`);
      
      allRecords.push(recordString);
    });
    
    return allRecords;
  }

  /**
   * 将 delta 平移应用到一条记录字符串的所有坐标键
   */
  applyDeltaToRecordString(recordString, props, deltaX, deltaY) {
    // LOCATION 已在外层处理，但这里冗余覆盖也安全
    if (props['LOCATION.X'] !== undefined) {
      const v = parseInt(props['LOCATION.X'] || 0) + deltaX;
      recordString = recordString.replace(/LOCATION\.X=-?\d+/, `LOCATION.X=${v}`);
    }
    if (props['LOCATION.Y'] !== undefined) {
      const v = parseInt(props['LOCATION.Y'] || 0) + deltaY;
      recordString = recordString.replace(/LOCATION\.Y=-?\d+/, `LOCATION.Y=${v}`);
    }
    if (props['CORNER.X'] !== undefined) {
      const v = parseInt(props['CORNER.X'] || 0) + deltaX;
      recordString = recordString.replace(/CORNER\.X=-?\d+/, `CORNER.X=${v}`);
    }
    if (props['CORNER.Y'] !== undefined) {
      const v = parseInt(props['CORNER.Y'] || 0) + deltaY;
      recordString = recordString.replace(/CORNER\.Y=-?\d+/, `CORNER.Y=${v}`);
    }
    Object.entries(props).forEach(([key, value]) => {
      if (/^X\d+$/.test(key)) {
        const newVal = parseInt(value || 0) + deltaX;
        const regex = new RegExp(`${key}=-?\\d+`);
        recordString = recordString.replace(regex, `${key}=${newVal}`);
      }
      if (/^Y\d+$/.test(key)) {
        const newVal = parseInt(value || 0) + deltaY;
        const regex = new RegExp(`${key}=-?\\d+`);
        recordString = recordString.replace(regex, `${key}=${newVal}`);
      }
    });
    return recordString;
  }

  /**
   * 计算模板的包围盒（基于所有坐标键：LOCATION/CORNER/Xn/Yn）
   */
  getTemplateBounds(template) {
    const xs = [];
    const ys = [];
    const pushNum = (arr, v) => { const n = parseInt(v); if (!Number.isNaN(n)) arr.push(n); };
    (template.allRecords || []).forEach(r => {
      const props = r.properties || {};
      if (props['LOCATION.X'] !== undefined) pushNum(xs, props['LOCATION.X']);
      if (props['LOCATION.Y'] !== undefined) pushNum(ys, props['LOCATION.Y']);
      if (props['CORNER.X'] !== undefined) pushNum(xs, props['CORNER.X']);
      if (props['CORNER.Y'] !== undefined) pushNum(ys, props['CORNER.Y']);
      Object.entries(props).forEach(([k, v]) => {
        if (/^X\d+$/.test(k)) pushNum(xs, v);
        if (/^Y\d+$/.test(k)) pushNum(ys, v);
      });
    });
    const minX = xs.length ? Math.min(...xs) : 0;
    const minY = ys.length ? Math.min(...ys) : 0;
    const maxX = xs.length ? Math.max(...xs) : minX;
    const maxY = ys.length ? Math.max(...ys) : minY;
    return { minX, minY, maxX, maxY };
  }

  /**
   * 仅基于图形记录(3..14)计算包围盒，排除标签与引脚，贴近Canvas的“器件外框”锚点
   */
  getTemplateGraphicBounds(template) {
    if (!template || !template.graphicRecords || template.graphicRecords.length === 0) return null;
    const xs = []; const ys = [];
    const pushNum = (arr, v) => { const n = parseInt(v); if (!Number.isNaN(n)) arr.push(n); };
    template.graphicRecords.forEach(r => {
      const p = r.properties || {};
      if (p['LOCATION.X'] !== undefined) pushNum(xs, p['LOCATION.X']);
      if (p['LOCATION.Y'] !== undefined) pushNum(ys, p['LOCATION.Y']);
      if (p['CORNER.X'] !== undefined) pushNum(xs, p['CORNER.X']);
      if (p['CORNER.Y'] !== undefined) pushNum(ys, p['CORNER.Y']);
      Object.entries(p).forEach(([k, v]) => {
        if (/^X\d+$/.test(k)) pushNum(xs, v);
        if (/^Y\d+$/.test(k)) pushNum(ys, v);
      });
    });
    if (xs.length === 0 || ys.length === 0) return null;
    const minX = Math.min(...xs), minY = Math.min(...ys);
    const maxX = Math.max(...xs), maxY = Math.max(...ys);
    return { minX, minY, maxX, maxY };
  }

  /**
   * 以主矩形作为锚点（优先 RECORD=14 Rectangle，其次 RECORD=10 Round rectangle）
   * 返回 {minX, minY, maxX, maxY}
   */
  getTemplateMainRectAnchor(template) {
    if (!template || !template.allRecords) return null;
    const rects = template.allRecords.filter(r => r.type === 14 || r.type === 10);
    if (rects.length === 0) return null;
    // 选择面积最大的矩形
    let best = null; let bestArea = -1;
    rects.forEach(r => {
      const p = r.properties || {};
      const x1 = parseInt(p['LOCATION.X'] || 0);
      const y1 = parseInt(p['LOCATION.Y'] || 0);
      const x2 = parseInt(p['CORNER.X'] || x1);
      const y2 = parseInt(p['CORNER.Y'] || y1);
      const minX = Math.min(x1, x2), minY = Math.min(y1, y2);
      const maxX = Math.max(x1, x2), maxY = Math.max(y1, y2);
      const area = Math.max(1, (maxX - minX)) * Math.max(1, (maxY - minY));
      if (area > bestArea) { bestArea = area; best = { minX, minY, maxX, maxY }; }
    });
    return best;
  }

  /**
   * 选择用于对齐 Canvas 左上角的模板锚点：
   * 1) 主矩形左上角；2) 图形外框左上角；3) 全记录外框左上角
   * 返回 { ax, ay }
   */
  getTemplateAnchorTopLeft(template) {
    // 特判：水平电位器（两端水平、滑动端在上/下）优先用由4条直线(RECORD=13)构成的最大矩形中心
    try {
      if (this.isHorizontalPotTemplate(template)) {
        const rect = this.getLargestRectFromAxisAlignedLines(template);
        if (rect) {
          const cx = Math.round((rect.minX + rect.maxX) / 2);
          const cy = Math.round((rect.minY + rect.maxY) / 2);
          // preferRectCenter: 提示放置时应以左右端引脚的中线中心作为画布目标点
          return { ax: cx, ay: cy, preferRectCenter: true };
        }
      }
    } catch (_) {}

    // 最优：使用模板“引脚质心”作为锚点（与布线/连接点对齐最稳健）
    try {
      const pc = this.getTemplatePinsCenter(template);
      if (pc && Number.isFinite(pc.x) && Number.isFinite(pc.y)) {
        return { ax: Math.round(pc.x), ay: Math.round(pc.y) };
      }
    } catch (_) {}

    // 次优：使用模板中组件记录的 LOCATION 作为锚点（与AD组件参考点一致）
    try {
      const comp = template?.componentRecord?.properties || {};
      const lx = comp['LOCATION.X'];
      const ly = comp['LOCATION.Y'];
      if (lx !== undefined && ly !== undefined && !isNaN(parseInt(lx)) && !isNaN(parseInt(ly))) {
        return { ax: parseInt(lx), ay: parseInt(ly) };
      }
    } catch (_) {}

    // 回退：以“图形中心”为模板锚点（优先主矩形中心，其次图形外框中心，最后全记录外框中心）
    const main = this.getTemplateMainRectAnchor(template);
    if (main) {
      const cx = Math.round((main.minX + main.maxX) / 2);
      const cy = Math.round((main.minY + main.maxY) / 2);
      return { ax: cx, ay: cy };
    }
    const gfx = this.getTemplateGraphicBounds(template);
    if (gfx) {
      const cx = Math.round((gfx.minX + gfx.maxX) / 2);
      const cy = Math.round((gfx.minY + gfx.maxY) / 2);
      return { ax: cx, ay: cy };
    }
    const all = this.getTemplateBounds(template);
    const cx = Math.round((all.minX + all.maxX) / 2);
    const cy = Math.round((all.minY + all.maxY) / 2);
    return { ax: cx, ay: cy };
  }

  /**
   * 基于实例判断是否为水平电位器：在画布坐标（考虑旋转）下，两端引脚 y 相同且第三脚 x 介于两端之间且 y 不同
   */
  isHorizontalPotInst(inst) {
    const refName = String(inst?.ref || inst?.symbol?.key || '').toUpperCase();
    if (!(/^RP\d*/.test(refName) || refName.includes('POT'))) return false;
    if (!Array.isArray(inst?.pins) || inst.pins.length < 3) return false;
    const pts = inst.pins.map(p => this.pinAbsCoord(inst, p));
    let ok = false;
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        if (pts[i].y === pts[j].y && pts[i].x !== pts[j].x) {
          const leftX = Math.min(pts[i].x, pts[j].x);
          const rightX = Math.max(pts[i].x, pts[j].x);
          for (let k = 0; k < pts.length; k++) {
            if (k === i || k === j) continue;
            const p = pts[k];
            if (p.x > leftX && p.x < rightX && p.y !== pts[i].y) { ok = true; break; }
          }
        }
        if (ok) break;
      }
      if (ok) break;
    }
    return ok;
  }

  /**
   * 获取画布中“左右端引脚中线中心”的 schdoc 浮点坐标（用于水平电位器对齐）
   */
  getCanvasPotMidlineCenterSch(inst) {
    const pts = inst.pins.map(p => this.pinAbsCoord(inst, p));
    // 找到同 y 的两端点
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        if (pts[i].y === pts[j].y && pts[i].x !== pts[j].x) {
          const xMid = (pts[i].x + pts[j].x) / 2;
          const yMid = pts[i].y; // 共享的 y
          return this.convertCenterFloat(xMid, yMid);
        }
      }
    }
    return null;
  }

  /**
   * 判断模板是否为“水平电位器”样式：
   * - 至少3个引脚
   * - 存在两引脚 y 相同（左右端），且第三脚 x 位于两者之间，y 与其不同（上/下）
   */
  isHorizontalPotTemplate(template) {
    try {
      const comp = template?.componentRecord?.properties || {};
      const idStr = `${comp.LIBREFERENCE || ''}|${comp.DESIGNITEMID || ''}`.toUpperCase();
      const isPotLib = idStr.includes('POT');
      const isRPName = /\bRP\d*/.test(idStr);
      if (!(isPotLib || isRPName)) return false;
    } catch(_) { return false; }
    const pins = template?.pinRecords || [];
    if (pins.length < 3) return false;
    const pts = pins.map(p => ({
      x: parseInt(p?.properties?.['LOCATION.X'] || 0),
      y: parseInt(p?.properties?.['LOCATION.Y'] || 0)
    }));
    let found = false;
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        if (pts[i].y === pts[j].y && pts[i].x !== pts[j].x) {
          const leftX = Math.min(pts[i].x, pts[j].x);
          const rightX = Math.max(pts[i].x, pts[j].x);
          for (let k = 0; k < pts.length; k++) {
            if (k === i || k === j) continue;
            const p = pts[k];
            if (p.x > leftX && p.x < rightX && p.y !== pts[i].y) {
              found = true;
              break;
            }
          }
        }
        if (found) break;
      }
      if (found) break;
    }
    return found;
  }

  /**
   * 从 RECORD=13 直线集合中推导最大轴对齐矩形（恰由四条边构成）
   */
  getLargestRectFromAxisAlignedLines(template) {
    const lines = (template?.allRecords || []).filter(r => r.type === 13);
    if (!lines.length) return null;
    const segments = lines.map(r => {
      const p = r.properties || {};
      const x1 = parseInt(p['LOCATION.X'] || 0);
      const y1 = parseInt(p['LOCATION.Y'] || 0);
      const x2 = parseInt(p['CORNER.X'] || x1);
      const y2 = parseInt(p['CORNER.Y'] || y1);
      return { x1, y1, x2, y2 };
    });

    const horizontals = [];
    const verticals = [];
    segments.forEach(s => {
      if (s.y1 === s.y2 && s.x1 !== s.x2) {
        horizontals.push({ y: s.y1, x1: Math.min(s.x1, s.x2), x2: Math.max(s.x1, s.x2) });
      } else if (s.x1 === s.x2 && s.y1 !== s.y2) {
        verticals.push({ x: s.x1, y1: Math.min(s.y1, s.y2), y2: Math.max(s.y1, s.y2) });
      }
    });
    if (!horizontals.length || !verticals.length) return null;

    // 尝试匹配四条边组成的矩形，选择面积最大者
    let best = null; let bestArea = -1;
    for (const top of horizontals) {
      for (const bottom of horizontals) {
        if (top === bottom) continue;
        if (top.y <= bottom.y) continue; // top 在上方
        // 取共同的 x 覆盖区间
        const minX = Math.max(Math.min(top.x1, top.x2), Math.min(bottom.x1, bottom.x2));
        const maxX = Math.min(Math.max(top.x1, top.x2), Math.max(bottom.x1, bottom.x2));
        if (maxX <= minX) continue;
        // 找到左右两条竖线，位于 minX/maxX 处，并覆盖 [bottom.y, top.y]
        const leftCandidates = verticals.filter(v => v.x >= minX && v.x <= minX + 1 && v.y1 <= bottom.y && v.y2 >= top.y);
        const rightCandidates = verticals.filter(v => v.x <= maxX && v.x >= maxX - 1 && v.y1 <= bottom.y && v.y2 >= top.y);
        if (!leftCandidates.length || !rightCandidates.length) continue;
        const left = leftCandidates[0];
        const right = rightCandidates[0];
        const minY = bottom.y; const maxY = top.y;
        const area = (maxX - minX) * (maxY - minY);
        if (area > bestArea) { bestArea = area; best = { minX, minY, maxX, maxY, left, right, top, bottom }; }
      }
    }
    return best;
  }

  /**
   * 坐标转换
   */
  convertCoordinates(x, y) {
    const scale = SCHDOC_CONFIG.COORDINATE_SCALE || 1;
    const invertY = SCHDOC_CONFIG.INVERT_Y !== false;
    const sheetHeight = SCHDOC_CONFIG.SHEET_HEIGHT || 800;
    const gx = Math.round(x / (GRID || 1)) * (GRID || 1);
    const gy = Math.round(y / (GRID || 1)) * (GRID || 1);
    return {
      x: Math.round(gx * scale),
      y: Math.round((invertY ? (sheetHeight - gy) : gy) * scale)
    };
  }

  // 不进行网格对齐的坐标转换，用于中心对齐避免半格误差
  convertCoordinatesNoSnap(x, y) {
    const scale = SCHDOC_CONFIG.COORDINATE_SCALE || 1;
    const invertY = SCHDOC_CONFIG.INVERT_Y !== false;
    const sheetHeight = SCHDOC_CONFIG.SHEET_HEIGHT || 800;
    const sx = Math.round(x * scale);
    const sy = Math.round(y * scale);
    return {
      x: sx,
      y: invertY ? Math.round(sheetHeight * scale - sy) : sy
    };
  }

  // 中心点转换（浮点，不四舍五入），用于计算 delta，再在写入时取整
  convertCenterFloat(x, y) {
    const scale = SCHDOC_CONFIG.COORDINATE_SCALE || 1;
    const invertY = SCHDOC_CONFIG.INVERT_Y !== false;
    const sheetHeight = SCHDOC_CONFIG.SHEET_HEIGHT || 800;
    const fx = x * scale;
    const fy = invertY ? ((sheetHeight - y) * scale) : (y * scale);
    return { x: fx, y: fy };
  }

  // 计算模板引脚中心（schdoc坐标）
  getTemplatePinsCenter(template) {
    const pins = template?.pinRecords || [];
    if (!pins.length) return null;
    let sx = 0, sy = 0, n = 0;
    pins.forEach(p => {
      const px = parseInt(p?.properties?.['LOCATION.X'] || 0);
      const py = parseInt(p?.properties?.['LOCATION.Y'] || 0);
      if (Number.isFinite(px) && Number.isFinite(py)) { sx += px; sy += py; n++; }
    });
    if (!n) return null;
    return { x: sx / n, y: sy / n };
  }

  // 计算画布引脚中心（Canvas 坐标→schdoc浮点）
  getCanvasPinsCenterSch(inst) {
    if (!Array.isArray(inst?.pins) || inst.pins.length === 0) return null;
    let sx = 0, sy = 0, n = 0;
    inst.pins.forEach(pin => {
      const a = this.pinAbsCoord(inst, pin);
      if (Number.isFinite(a.x) && Number.isFinite(a.y)) { sx += a.x; sy += a.y; n++; }
    });
    if (!n) return null;
    const c = { x: sx / n, y: sy / n };
    return this.convertCenterFloat(c.x, c.y); // 浮点schdoc
  }

  /**
   * 将 Canvas 坐标系下的增量(dx,dy)转换为 schdoc 坐标增量
   * 注意：Y 轴翻转意味着增量需要取反
   */
  convertDelta(dx, dy) {
    const scale = SCHDOC_CONFIG.COORDINATE_SCALE || 1;
    const invertY = SCHDOC_CONFIG.INVERT_Y !== false;
    return {
      dx: Math.round(dx * scale),
      dy: Math.round((invertY ? -dy : dy) * scale)
    };
  }

  // 全局/按库偏移（schdoc坐标系，直接相加）
  applyBiasForLib(libRef) {
    const { COMPONENT_BIAS_X=0, COMPONENT_BIAS_Y=0, PER_LIB_BIAS={} } = SCHDOC_CONFIG || {};
    const lib = String(libRef||'');
    const per = PER_LIB_BIAS[lib] || { dx: 0, dy: 0 };
    return { dx: Math.round(COMPONENT_BIAS_X + (per.dx||0)), dy: Math.round(COMPONENT_BIAS_Y + (per.dy||0)) };
  }

  /**
   * 将平移量对齐到网格（schdoc坐标系）
   */
  snapDelta(dx, dy) {
    const g = (GRID || 1);
    const snap = (v) => Math.round(v / g) * g;
    return { dx: snap(dx), dy: snap(dy) };
  }

  /**
   * 局部坐标到旋转后的有效坐标
   */
  localToEffForAngle(inst, x, y, angle) {
    const a = ((angle % 360) + 360) % 360;
    const w = inst?.symbol?.w || 0;
    const h = inst?.symbol?.h || 0;
    if (a === 0) return { x, y };
    if (a === 90) return { x: h - y, y: x };
    if (a === 180) return { x: w - x, y: h - y };
    if (a === 270) return { x: y, y: w - x };
    return { x, y };
  }

  /**
   * 计算引脚的画布绝对坐标
   */
  pinAbsCoord(inst, pin) {
    const p = this.localToEffForAngle(inst, pin.x, pin.y, inst.rot || 0);
    return { x: (inst.x || 0) + p.x, y: (inst.y || 0) + p.y };
  }

  /**
   * 从 App.wires 中提取所有端点（Canvas 坐标）
   */
  collectWirePoints() {
    const pts = [];
    try {
      (App.wires || []).forEach(w => {
        const arr = w?.points || w?.pts || w || [];
        if (Array.isArray(arr)) {
          arr.forEach(p => { if (p && typeof p.x === 'number' && typeof p.y === 'number') pts.push({ x: p.x, y: p.y }); });
        }
      });
    } catch(_) {}
    return pts;
  }

  /**
   * 计算将元件平移到最可能对齐导线的微调向量（Canvas 坐标）
   * 返回 { dx, dy } 或 {0,0}
   */
  computeFineAlignDelta(inst) {
    try {
      const wires = this.collectWirePoints();
      if (!wires.length || !Array.isArray(inst?.pins) || inst.pins.length === 0) return { dx: 0, dy: 0 };
      const deltas = [];
      const maxDist = 120; // 最大考虑距离
      const minSamples = 2;
      inst.pins.forEach(pin => {
        const p = this.pinAbsCoord(inst, pin);
        // 找最近的导线点
        let best = null; let bestD2 = Infinity;
        for (const q of wires) {
          const dx = q.x - p.x, dy = q.y - p.y;
          const d2 = dx*dx + dy*dy;
          if (d2 < bestD2) { bestD2 = d2; best = { dx, dy }; }
        }
        if (best && Math.sqrt(bestD2) <= maxDist) {
          deltas.push(best);
        }
      });
      if (deltas.length < minSamples) return { dx: 0, dy: 0 };
      // 取中位数，减少离群
      const xs = deltas.map(d => d.dx).sort((a,b)=>a-b);
      const ys = deltas.map(d => d.dy).sort((a,b)=>a-b);
      const mid = (arr) => arr.length%2? arr[(arr.length-1)/2] : Math.round((arr[arr.length/2-1] + arr[arr.length/2]) / 2);
      let dx = mid(xs), dy = mid(ys);
      // 对齐到网格
      const g = (GRID || 1);
      dx = Math.round(dx / g) * g; dy = Math.round(dy / g) * g;
      // 过大的整体位移可能是误判，限制
      if (Math.abs(dx) > 300 || Math.abs(dy) > 300) return { dx: 0, dy: 0 };
      return { dx, dy };
    } catch(_) { return { dx: 0, dy: 0 }; }
  }

  /**
   * 生成唯一ID
   */
  generateUniqueId() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    let result = '';
    for (let i = 0; i < 8; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
  }

  /**
   * 创建备用元件记录（当schdoc文件不可用时）
   */
  createFallbackComponent(inst) {
    const coords = this.convertCoordinates(inst.x, inst.y);
    
    return {
      RECORD: 1,
      LIBREFERENCE: inst.symbol?.key || inst.ref,
      PARTCOUNT: 2,
      DISPLAYMODECOUNT: 1,
      INDEXINSHEET: 0,
      OWNERPARTID: -1,
      LOCATION_X: coords.x,
      LOCATION_Y: coords.y,
      CURRENTPARTID: 1,
      LIBRARYPATH: '*',
      SOURCELIBRARYNAME: '*',
      SHEETPARTFILENAME: '*',
      TARGETFILENAME: '*',
      UNIQUEID: this.generateUniqueId(),
      AREACOLOR: 11599871,
      COLOR: 128,
      PARTIDLOCKED: true,
      DESIGNITEMID: inst.symbol?.key || inst.ref,
      ALLPINCOUNT: inst.pins?.length || 0
    };
  }

  /**
   * 创建备用引脚记录
   */
  createFallbackPins(inst, ownerIndex) {
    if (!inst.pins || inst.pins.length === 0) {
      return [];
    }

    return inst.pins.map((pin, index) => {
      const coords = this.convertCoordinates(pin.x, pin.y);
      
      return {
        RECORD: 2,
        OWNERINDEX: ownerIndex,
        OWNERPARTID: 1,
        FORMALTYPE: 1,
        ELECTRICAL: 4, // Passive
        PINCONGLOMERATE: 33, // 向右
        PINLENGTH: 10,
        LOCATION_X: coords.x,
        LOCATION_Y: coords.y,
        NAME: pin.name || pin.number,
        DESIGNATOR: pin.number,
        SWAPIDPIN: pin.number,
        SWAPIDPART: '&',
        UNIQUEID: this.generateUniqueId()
      };
    });
  }

  /**
   * 获取统计信息
   */
  getStats() {
    return {
      totalLoaded: this.library.size,
      loadedComponents: Array.from(this.loadedComponents),
      availableComponents: Array.from(this.library.keys())
    };
  }
}

// 创建全局实例
export const schdocLibrary = new SchdocLibrary();
