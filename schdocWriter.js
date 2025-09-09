import { App } from './state.js';
import { uuid } from './utils.js';
import { SCHDOC_CONFIG, GRID } from './config.js';
import { schdocLibrary } from './schdocLibrary.js';

/**
 * schdoc文件写入引擎
 * 负责将Canvas数据转换为schdoc格式并写入文件
 */
export class SchdocWriter {
  constructor() {
    this.records = [];
    this.componentIndex = new Map(); // 元件索引
    this.wireIndex = new Map();      // 导线索引
    this.netLabelIndex = new Map();  // 网络标签索引
    this.powerPortIndex = new Map(); // 电源端口索引
    this.currentIndex = 0;           // 当前记录索引
    this.uniqueIdCounter = 0;        // 唯一ID计数器
    this.recordIndexMemo = [];       // 保存每个RECORD的索引和类型
  }

  /**
   * 生成唯一ID
   */
  generateUniqueId() {
    return schdocLibrary.generateUniqueId();
  }

  /**
   * 添加RECORD到memo中
   */
  addRecordToMemo(recordType, index) {
    this.recordIndexMemo.push({ type: recordType, index: index });
  }

  /**
   * 查找最近的RECORD=1的索引
   */
  findLastComponentIndex() {
    for (let i = this.recordIndexMemo.length - 1; i >= 0; i--) {
      if (this.recordIndexMemo[i].type === 1) {
        return this.recordIndexMemo[i].index;
      }
    }
    return -1;
  }

  /**
   * 坐标转换：Canvas坐标 -> schdoc坐标
   * schdoc使用1/100英寸单位，原点在左下角
   */
  convertCoordinates(x, y) {
    // Canvas坐标 -> schdoc坐标（Y轴翻转到Sheet坐标系，原点左下）
    const scale = SCHDOC_CONFIG.COORDINATE_SCALE;
    const invertY = SCHDOC_CONFIG.INVERT_Y !== false; // 默认翻转，允许通过配置关闭
    const sheetHeight = SCHDOC_CONFIG.SHEET_HEIGHT || 0;
    const gx = Math.round(x / (GRID || 1)) * (GRID || 1);
    const gy = Math.round(y / (GRID || 1)) * (GRID || 1);
    return {
      x: Math.round(gx * scale),
      y: Math.round((invertY ? (sheetHeight - gy) : gy) * scale)
    };
  }

  /**
   * 创建Header记录（按照format.md规范）
   */
  createHeader() {
    // 按照format.md规范：|HEADER=Protel for Windows - Schematic Capture Ascii File Version 5.0|WEIGHT|MINORVERSION=2|UNIQUEID
    return `|HEADER=Protel for Windows - Schematic Capture Ascii File Version 5.0|WEIGHT=${this.records.length}|MINORVERSION=2|UNIQUEID=${this.generateUniqueId()}`;
  }

  /**
   * 创建Sheet记录（按照format.md规范）
   */
  createSheet() {
    // 与配置保持一致的自定义纸张大小
    const W = SCHDOC_CONFIG.SHEET_WIDTH || 1000;
    const H = SCHDOC_CONFIG.SHEET_HEIGHT || 800;
    return `|RECORD=31|FONTIDCOUNT=1|SIZE1=10|FONTNAME1=Times New Roman|SIZE2=10|ROTATION2=180|FONTNAME2=Times New Roman|USEMBCS=T|ISBOC=T|HOTSPOTGRIDON=T|HOTSPOTGRIDSIZE=4|SHEETSTYLE=6|SYSTEMFONT=1|BORDERON=T|TITLEBLOCKON=T|SHEETNUMBERSPACESIZE=4|AREACOLOR=16317695|SNAPGRIDON=T|SNAPGRIDSIZE=10|VISIBLEGRIDON=T|VISIBLEGRIDSIZE=10|CUSTOMX=${W}|CUSTOMY=${H}|CUSTOMXZONES=4|CUSTOMYZONES=4|CUSTOMMARGINWIDTH=20|DISPLAY_UNIT=4`;
  }

  /**
   * 创建元件记录
   */
  createComponent(inst) {
    const coords = this.convertCoordinates(inst.x, inst.y);
    const uniqueId = this.generateUniqueId();
    const ownerIndex = this.currentIndex++;
    
    // 获取库引用名称
    const libRef = inst.symbol?.key || inst.ref || 'UNKNOWN';
    
    // 计算引脚数量
    const pinCount = inst.pins?.length || 0;
    
    // 创建元件记录
    const componentRecord = `|RECORD=1|LIBREFERENCE=${libRef}|PARTCOUNT=2|DISPLAYMODECOUNT=1|OWNERPARTID=-1|LOCATION.X=${coords.x}|LOCATION.Y=${coords.y}|CURRENTPARTID=1|LIBRARYPATH=*|SOURCELIBRARYNAME=*|SHEETPARTFILENAME=*|TARGETFILENAME=*|UNIQUEID=${uniqueId}|AREACOLOR=11599871|COLOR=128|PARTIDLOCKED=T|DESIGNITEMID=${libRef}|ALLPINCOUNT=${pinCount}`;
    
    this.records.push(componentRecord);
    this.componentIndex.set(inst.id, { ownerIndex, uniqueId, record: componentRecord });
    
    return { ownerIndex, uniqueId };
  }

  /**
   * 创建引脚记录
   */
  createPin(inst, pin, ownerIndex) {
    const coords = this.convertCoordinates(pin.x, pin.y);
    
    // 计算引脚方向 (PINCONGLOMERATE)
    let pinConglomerate = 33; // 默认向右
    if (inst.rot) {
      const angle = inst.rot % 360;
      if (angle === 0) pinConglomerate = 33;      // 向右
      else if (angle === 90) pinConglomerate = 35; // 向上
      else if (angle === 180) pinConglomerate = 35; // 向左
      else if (angle === 270) pinConglomerate = 33; // 向下
    }
    
    // 确定电气类型
    let electrical = 4; // 默认Passive
    if (pin.name && (pin.name.includes('VCC') || pin.name.includes('VDD'))) {
      electrical = 7; // Power
    } else if (pin.name && pin.name.includes('GND')) {
      electrical = 7; // Power
    } else if (pin.name && (pin.name.includes('IN') || pin.name.includes('INPUT'))) {
      electrical = 0; // Input
    } else if (pin.name && (pin.name.includes('OUT') || pin.name.includes('OUTPUT'))) {
      electrical = 2; // Output
    }
    
    const pinRecord = `|RECORD=2|OWNERINDEX=${ownerIndex}|OWNERPARTID=1|FORMALTYPE=1|ELECTRICAL=${electrical}|PINCONGLOMERATE=${pinConglomerate}|PINLENGTH=10|LOCATION.X=${coords.x}|LOCATION.Y=${coords.y}|NAME=${pin.name || pin.number}|DESIGNATOR=${pin.number}|SWAPIDPIN=${pin.number}|%UTF8%SWAPIDPART=¦&¦|||SWAPIDPART=&|`;
    
    this.records.push(pinRecord);
    return pinRecord;
  }

  /**
   * 创建元件标签记录
   */
  createComponentLabels(inst, ownerIndex) {
    const coords = this.convertCoordinates(inst.x, inst.y);
    
    // 创建元件标号记录
    const designatorRecord = `|RECORD=34|OWNERINDEX=${ownerIndex}|OWNERPARTID=-1|LOCATION.X=${coords.x}|LOCATION.Y=${coords.y}|COLOR=8388608|FONTID=1|TEXT=${inst.ref}|NAME=Designator|READONLYSTATE=1|UNIQUEID=${this.generateUniqueId()}`;
    
    // 创建元件值记录
    const commentRecord = `|RECORD=41|OWNERINDEX=${ownerIndex}|OWNERPARTID=-1|LOCATION.X=${coords.x}|LOCATION.Y=${coords.y - 20}|COLOR=8388608|FONTID=1|TEXT=${inst.value || ''}|NAME=Comment|UNIQUEID=${this.generateUniqueId()}`;
    
    this.records.push(designatorRecord);
    this.records.push(commentRecord);
    
    return { designatorRecord, commentRecord };
  }

  /**
   * 创建导线记录（按照format.md中RECORD=27的规范）
   */
  createWire(points, netName) {
    if (!points || points.length < 2) return null;
    
    const coords = points.map(p => this.convertCoordinates(p.x, p.y));
    const locationCount = coords.length;
    
    // 按照format.md规范构建坐标字符串
    // |LOCATIONCOUNT|X_n_|Y_n_|...
    let coordString = '';
    for (let i = 0; i < coords.length; i++) {
      coordString += `|X${i + 1}=${coords[i].x}|Y${i + 1}=${coords[i].y}`;
    }
    
    // 按照format.md规范：|RECORD=27|OWNERPARTID=-1|LINEWIDTH|COLOR|UNIQUEID|LOCATIONCOUNT|X_n_|Y_n_|...
    const wireRecord = `|RECORD=27|OWNERPARTID=-1|LINEWIDTH=1|COLOR=8388608|UNIQUEID=${this.generateUniqueId()}|LOCATIONCOUNT=${locationCount}${coordString}`;
    
    this.records.push(wireRecord);
    this.wireIndex.set(netName || 'unnamed', wireRecord);
    
    return wireRecord;
  }

  /**
   * 创建网络标签记录
   */
  createNetLabel(label) {
    const coords = this.convertCoordinates(label.x, label.y);
    
    const netLabelRecord = `|RECORD=25|OWNERPARTID=-1|LOCATION.X=${coords.x}|LOCATION.Y=${coords.y}|COLOR=128|FONTID=1|TEXT=${label.name}|UNIQUEID=${this.generateUniqueId()}`;
    
    this.records.push(netLabelRecord);
    this.netLabelIndex.set(label.name, netLabelRecord);
    
    return netLabelRecord;
  }

  /**
   * 创建电源端口记录
   */
  createPowerPort(port) {
    const coords = this.convertCoordinates(port.x, port.y);
    
    // 确定电源符号样式
    let style = 2; // 默认Tee off rail
    if (port.name && port.name.toUpperCase().includes('GND')) {
      style = 4; // Ground
    } else if (port.name && (port.name.toUpperCase().includes('VCC') || port.name.toUpperCase().includes('VDD'))) {
      style = 7; // Power
    }
    
    const powerPortRecord = `|RECORD=17|OWNERPARTID=-1|STYLE=${style}|SHOWNETNAME=T|LOCATION.X=${coords.x}|LOCATION.Y=${coords.y}|ORIENTATION=1|COLOR=128|FONTID=1|TEXT=${port.name}|UNIQUEID=${this.generateUniqueId()}`;
    
    this.records.push(powerPortRecord);
    this.powerPortIndex.set(port.name, powerPortRecord);
    
    return powerPortRecord;
  }

  /**
   * 添加元件到schdoc（根据元件ref直接查找svglib中的schdoc文件）
   */
  async addComponent(inst) {
    // 使用元件的ref来查找schdoc文件，而不是symbol.key
    // 例如：R1 -> R1.schdoc, C1 -> C1.schdoc
    const componentKey = inst.ref;
    
    const template = await schdocLibrary.loadComponentSchdoc(componentKey);
    
    if (template) {
      // 使用schdoc模板创建元件
      return this.addComponentFromTemplate(inst, template);
    } else {
      // 模板缺失时，使用通用记录作为兜底，避免导出丢失元件
      console.warn(`未找到 ${componentKey}.schdoc 文件，使用通用元件导出`);
      const comp = this.createComponent(inst);
      const ownerIndex = this.findLastComponentIndex();
      // 生成引脚与标签
      (inst.pins || []).forEach(pin => this.createPin(inst, pin, ownerIndex));
      this.createComponentLabels(inst, ownerIndex);
      return ownerIndex;
    }
  }

  /**
   * 基于schdoc模板添加元件
   */
  addComponentFromTemplate(inst, template) {
    // 计算ownerIndex：RECORD=1这条记录在文件中的索引（从0开始计数）
    // 文件结构：Header(1行) + Sheet(1行) + 元件记录
    // 第一个RECORD=1的索引是2，所以OWNERINDEX=2
    // 第二个RECORD=1的索引是17，所以OWNERINDEX=17
    // 使用当前records数组长度 + 1（因为Header和Sheet不算RECORD，从第一个RECORD开始计数）
    const ownerIndex = this.records.length + 1;
    
    // 按照模板的原始顺序添加所有记录，保持RECORD顺序不变
    const allRecords = schdocLibrary.createAllRecordsFromTemplate(inst, template, ownerIndex);
    allRecords.forEach(record => {
      this.records.push(record);
    });
    
    // 保存元件索引信息
    this.componentIndex.set(inst.id, { ownerIndex, record: allRecords[0] });
    
    return ownerIndex;
  }



  /**
   * 构建记录字符串
   */
  buildRecordString(props) {
    const parts = [];
    for (const [key, value] of Object.entries(props)) {
      if (value !== undefined && value !== null) {
        parts.push(`${key}=${value}`);
      }
    }
    return '|' + parts.join('|');
  }

  /**
   * 更新元件位置
   */
  updateComponent(inst) {
    const componentInfo = this.componentIndex.get(inst.id);
    if (!componentInfo) return;
    
    const coords = this.convertCoordinates(inst.x, inst.y);
    
    // 更新元件记录中的位置
    const updatedRecord = componentInfo.record.replace(
      /LOCATION\.X=\d+\|LOCATION\.Y=\d+/,
      `LOCATION.X=${coords.x}|LOCATION.Y=${coords.y}`
    );
    
    // 更新记录数组中的记录
    const recordIndex = this.records.findIndex(r => r === componentInfo.record);
    if (recordIndex !== -1) {
      this.records[recordIndex] = updatedRecord;
      componentInfo.record = updatedRecord;
    }
  }

  /**
   * 添加导线到schdoc
   */
  addWire(points, netName) {
    return this.createWire(points, netName);
  }

  /**
   * 添加网络标签到schdoc
   */
  addNetLabel(label) {
    return this.createNetLabel(label);
  }

  /**
   * 添加电源端口到schdoc
   */
  addPowerPort(port) {
    return this.createPowerPort(port);
  }

  /**
   * 生成完整的schdoc文件内容
   */
  generateSchdocContent() {
    const header = this.createHeader();
    const sheet = this.createSheet();
    const EOL = '\r\n';
    
    // 构建完整内容，每个RECORD都是一行
    let content = header + EOL;
    content += sheet + EOL;
    
    // 添加所有记录，每个RECORD都是一行
    this.records.forEach(record => {
      content += record + EOL;
    });
    
    // 添加收尾格式
    content += '|HEADER=Icon storage' + EOL;
    content += '|HEADER=Protel for Windows - Schematic Capture Ascii File Version 5.0' + EOL;
    
    return content;
  }

  /**
   * 导出schdoc文件
   */
  exportSchdoc(filename = 'schematic.schdoc') {
    const content = this.generateSchdocContent();
    
    // 创建下载链接
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    
    return content;
  }

  /**
   * 清空所有记录
   */
  clear() {
    this.records = [];
    this.componentIndex.clear();
    this.wireIndex.clear();
    this.netLabelIndex.clear();
    this.powerPortIndex.clear();
    this.currentIndex = 0;
    this.uniqueIdCounter = 0;
  }

  /**
   * 获取统计信息
   */
  getStats() {
    return {
      totalRecords: this.records.length,
      components: this.componentIndex.size,
      wires: this.wireIndex.size,
      netLabels: this.netLabelIndex.size,
      powerPorts: this.powerPortIndex.size
    };
  }
}

// 创建全局实例
export const schdocWriter = new SchdocWriter();
