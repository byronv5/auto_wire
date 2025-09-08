import { detectType, isPowerName, isGndName } from './component.js';
import { SCHDOC_CONFIG } from './config.js';

/**
 * schdoc数据映射层
 * 将Canvas数据结构映射为schdoc记录格式
 */
export class SchdocMapper {
  constructor() {
    this.coordinateScale = SCHDOC_CONFIG.COORDINATE_SCALE;
    this.defaultColors = SCHDOC_CONFIG.DEFAULT_COLORS;
  }

  /**
   * 坐标转换
   */
  convertCoordinates(x, y) {
    return {
      x: Math.round(x * this.coordinateScale),
      y: Math.round(y * this.coordinateScale)
    };
  }

  /**
   * 角度转换
   */
  convertRotation(angle) {
    // 将角度转换为schdoc的ORIENTATION值
    const normalizedAngle = ((angle % 360) + 360) % 360;
    if (normalizedAngle === 0) return 0;
    if (normalizedAngle === 90) return 1;
    if (normalizedAngle === 180) return 2;
    if (normalizedAngle === 270) return 3;
    return 0; // 默认
  }

  /**
   * 映射元件到schdoc格式
   */
  mapComponentToSchdoc(inst) {
    const coords = this.convertCoordinates(inst.x, inst.y);
    const orientation = this.convertRotation(inst.rot || 0);
    
    return {
      // 基本信息
      libReference: inst.symbol?.key || inst.ref || 'UNKNOWN',
      componentDescription: this.getComponentDescription(inst),
      partCount: 2, // 默认值
      displayModeCount: 1,
      indexInSheet: 0, // 将在写入时设置
      ownerPartId: -1,
      location: coords,
      orientation: orientation,
      currentPartId: 1,
      
      // 库信息
      libraryPath: '*',
      sourceLibraryName: '*',
      sheetPartFileName: '*',
      targetFileName: '*',
      
      // 外观
      areaColor: this.defaultColors.background,
      color: this.defaultColors.component,
      
      // 锁定状态
      partIdLocked: true,
      designatorLocked: false,
      
      // 引脚信息
      allPinCount: inst.pins?.length || 0,
      
      // 唯一标识
      uniqueId: this.generateUniqueId(),
      designItemId: inst.symbol?.key || inst.ref
    };
  }

  /**
   * 映射引脚到schdoc格式
   */
  mapPinToSchdoc(pin, ownerIndex, inst) {
    const coords = this.convertCoordinates(pin.x, pin.y);
    
    return {
      ownerIndex: ownerIndex,
      ownerPartId: 1,
      formalType: 1,
      electrical: this.getPinElectricalType(pin),
      pinConglomerate: this.getPinConglomerate(pin, inst),
      pinLength: this.getPinLength(pin),
      location: coords,
      name: pin.name || pin.number,
      designator: pin.number,
      swapIdPin: pin.number,
      swapIdPart: '&'
    };
  }

  /**
   * 映射导线到schdoc格式
   */
  mapWireToSchdoc(points, netName) {
    if (!points || points.length < 2) return null;
    
    const coords = points.map(p => this.convertCoordinates(p.x, p.y));
    
    return {
      indexInSheet: 0, // 将在写入时设置
      ownerPartId: -1,
      lineWidth: 1,
      color: this.defaultColors.wire,
      uniqueId: this.generateUniqueId(),
      locationCount: coords.length,
      coordinates: coords
    };
  }

  /**
   * 映射网络标签到schdoc格式
   */
  mapNetLabelToSchdoc(label) {
    const coords = this.convertCoordinates(label.x, label.y);
    
    return {
      indexInSheet: 0, // 将在写入时设置
      ownerPartId: -1,
      location: coords,
      color: this.defaultColors.netLabel,
      fontId: 1,
      text: label.name,
      uniqueId: this.generateUniqueId()
    };
  }

  /**
   * 映射电源端口到schdoc格式
   */
  mapPowerPortToSchdoc(port) {
    const coords = this.convertCoordinates(port.x, port.y);
    
    return {
      indexInSheet: 0, // 将在写入时设置
      ownerPartId: -1,
      style: this.getPowerPortStyle(port.name),
      showNetName: true,
      location: coords,
      orientation: this.getPowerPortOrientation(port),
      color: this.defaultColors.powerPort,
      fontId: 1,
      text: port.name,
      uniqueId: this.generateUniqueId()
    };
  }

  /**
   * 获取元件描述
   */
  getComponentDescription(inst) {
    const type = detectType(inst);
    const descriptions = {
      'MCU': 'Microcontroller',
      'IC': 'Integrated Circuit',
      'Resistor': 'Resistor',
      'Capacitor': 'Capacitor',
      'Inductor': 'Inductor',
      'Diode': 'Diode',
      'Crystal': 'Crystal Oscillator',
      'Connector': 'Connector',
      'Misc': 'Component'
    };
    return descriptions[type] || 'Component';
  }

  /**
   * 获取引脚电气类型
   */
  getPinElectricalType(pin) {
    const name = (pin.name || '').toUpperCase();
    
    if (isPowerName(name)) return 7; // Power
    if (isGndName(name)) return 7;   // Power
    if (name.includes('IN') || name.includes('INPUT')) return 0; // Input
    if (name.includes('OUT') || name.includes('OUTPUT')) return 2; // Output
    if (name.includes('CLK') || name.includes('CLOCK')) return 0; // Input
    if (name.includes('RESET') || name.includes('RST')) return 0; // Input
    
    return 4; // Passive (默认)
  }

  /**
   * 获取引脚方向
   */
  getPinConglomerate(pin, inst) {
    // 根据元件旋转角度和引脚位置计算方向
    const angle = inst.rot || 0;
    const normalizedAngle = ((angle % 360) + 360) % 360;
    
    // 简化的方向计算
    if (normalizedAngle === 0) return 33;      // 向右
    if (normalizedAngle === 90) return 35;     // 向上
    if (normalizedAngle === 180) return 35;    // 向左
    if (normalizedAngle === 270) return 33;    // 向下
    
    return 33; // 默认向右
  }

  /**
   * 获取引脚长度
   */
  getPinLength(pin) {
    // 根据引脚类型返回合适的长度
    const name = (pin.name || '').toUpperCase();
    
    if (isPowerName(name) || isGndName(name)) return 20; // 电源引脚较长
    if (name.includes('CLK') || name.includes('RESET')) return 15; // 重要信号
    
    return 10; // 默认长度
  }

  /**
   * 获取电源端口样式
   */
  getPowerPortStyle(name) {
    const upperName = name.toUpperCase();
    
    if (upperName.includes('GND')) return 4; // Ground
    if (upperName.includes('VCC') || upperName.includes('VDD')) return 7; // Power
    if (upperName.includes('VEE') || upperName.includes('VSS')) return 5; // Power ground
    
    return 2; // Tee off rail (默认)
  }

  /**
   * 获取电源端口方向
   */
  getPowerPortOrientation(port) {
    // 根据端口类型返回合适的方向
    const name = port.name.toUpperCase();
    
    if (name.includes('GND')) return 3; // 向下
    if (name.includes('VCC') || name.includes('VDD')) return 1; // 向上
    
    return 1; // 默认向上
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
   * 映射元件标签
   */
  mapComponentLabels(inst, ownerIndex) {
    const coords = this.convertCoordinates(inst.x, inst.y);
    
    return {
      designator: {
        ownerIndex: ownerIndex,
        indexInSheet: -1,
        ownerPartId: -1,
        location: coords,
        color: this.defaultColors.component,
        fontId: 1,
        text: inst.ref,
        name: 'Designator',
        readonlyState: 1,
        uniqueId: this.generateUniqueId()
      },
      comment: {
        ownerIndex: ownerIndex,
        indexInSheet: -1,
        ownerPartId: -1,
        location: { x: coords.x, y: coords.y - 20 },
        color: this.defaultColors.component,
        fontId: 1,
        text: inst.value || '',
        name: 'Comment',
        uniqueId: this.generateUniqueId()
      }
    };
  }

  /**
   * 映射Sheet记录
   */
  mapSheetToSchdoc() {
    return {
      fontIdCount: 2,
      fonts: [
        { size: 10, name: 'Times New Roman' },
        { size: 10, rotation: 180, name: 'Times New Roman' }
      ],
      useMBCS: true,
      isBOC: true,
      hotspotGridOn: true,
      hotspotGridSize: 4,
      sheetStyle: 6, // B size
      systemFont: 1,
      borderOn: true,
      titleBlockOn: true,
      sheetNumberSpaceSize: 4,
      areaColor: this.defaultColors.background,
      snapGridOn: true,
      snapGridSize: 10,
      visibleGridOn: true,
      visibleGridSize: 10,
      customX: 1000,
      customY: 800,
      customXZones: 4,
      customYZones: 4,
      customMarginWidth: 20,
      displayUnit: 4 // 1/100 inch
    };
  }

  /**
   * 映射Header记录
   */
  mapHeaderToSchdoc(weight) {
    return {
      header: 'Protel for Windows - Schematic Capture Ascii File Version 5.0',
      weight: weight,
      minorVersion: 2,
      uniqueId: this.generateUniqueId()
    };
  }
}

// 创建全局实例
export const schdocMapper = new SchdocMapper();
