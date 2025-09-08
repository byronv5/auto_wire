import { schdocWriter } from './schdocWriter.js';
import { schdocLibrary } from './schdocLibrary.js';
import { App } from './state.js';
import { toast } from './utils.js';

/**
 * schdoc实时同步管理器
 * 监听Canvas变化并触发schdoc更新
 */
export class SchdocSync {
  constructor() {
    this.enabled = true; // 强制始终启用同步
    this.pendingUpdates = new Set();
    
    // 绑定事件处理器
    this.setupEventHandlers();
  }

  /**
   * 设置事件处理器
   */
  setupEventHandlers() {
    // 监听应用状态变化
    this.observeAppState();
  }

  /**
   * 监听应用状态变化
   */
  observeAppState() {
    // 使用Proxy监听App.inst数组变化
    const originalInst = App.inst;
    App.inst = new Proxy(originalInst, {
      set: (target, property, value) => {
        const result = Reflect.set(target, property, value);
        
        if (this.enabled && typeof property === 'number') {
          // 元件数组变化
          this.onComponentChanged(property, value);
        } else if (this.enabled && property === 'length') {
          // 数组长度变化
          this.onComponentArrayChanged();
        }
        
        return result;
      }
    });

    // 监听导线变化
    const originalWires = App.wires;
    App.wires = new Proxy(originalWires, {
      set: (target, property, value) => {
        const result = Reflect.set(target, property, value);
        
        if (this.enabled && typeof property === 'number') {
          this.onWireChanged(property, value);
        }
        
        return result;
      }
    });

    // 监听网络标签变化
    const originalNetLabels = App.netLabels;
    App.netLabels = new Proxy(originalNetLabels, {
      set: (target, property, value) => {
        const result = Reflect.set(target, property, value);
        
        if (this.enabled && typeof property === 'number') {
          this.onNetLabelChanged(property, value);
        }
        
        return result;
      }
    });
  }

  /**
   * 元件变化处理
   */
  onComponentChanged(index, component) {
    if (!component) return;
    
    this.pendingUpdates.add(`component_${component.id}`);
    this.scheduleUpdate();
  }

  /**
   * 元件数组变化处理
   */
  onComponentArrayChanged() {
    this.pendingUpdates.add('components_array');
    this.scheduleUpdate();
  }

  /**
   * 导线变化处理
   */
  onWireChanged(index, wire) {
    if (!wire) return;
    
    this.pendingUpdates.add(`wire_${index}`);
    this.scheduleUpdate();
  }

  /**
   * 网络标签变化处理
   */
  onNetLabelChanged(index, label) {
    if (!label) return;
    
    this.pendingUpdates.add(`netlabel_${index}`);
    this.scheduleUpdate();
  }

  /**
   * 安排更新
   */
  scheduleUpdate() {
    if (this.updateTimeout) {
      clearTimeout(this.updateTimeout);
    }
    
    // 延迟更新，避免频繁操作
    this.updateTimeout = setTimeout(() => {
      this.processPendingUpdates();
    }, 100);
  }

  /**
   * 处理待更新项（只更新内存数据，不自动导出文件）
   */
  processPendingUpdates() {
    if (this.pendingUpdates.size === 0) return;
    
    try {
      this.syncToSchdoc();
      this.pendingUpdates.clear();
    } catch (error) {
      console.error('schdoc同步错误:', error);
      toast('schdoc同步失败: ' + error.message, 'error');
    }
  }

  /**
   * 同步到schdoc（支持异步加载schdoc库文件）
   */
  async syncToSchdoc() {
    if (!this.enabled) return;
    
    try {
      // 清空现有记录
      schdocWriter.clear();
      
      // 预加载所有元件的schdoc文件
      await schdocLibrary.loadAllComponentSchdocs();
      
      // 同步所有元件（现在使用真正的schdoc模板）
      console.log('开始同步元件，总数:', App.inst.length);
      for (const inst of App.inst) {
        console.log('同步元件:', inst.symbol?.key || inst.ref, inst);
        const result = await schdocWriter.addComponent(inst);
        console.log('元件同步结果:', result);
      }
      
      // 同步所有导线
      console.log('开始同步导线，总数:', App.wires.length);
      App.wires.forEach((wire, index) => {
        if (wire && wire.getAttribute) {
          const netName = wire.getAttribute('data-net') || '';
          const pathData = wire.getAttribute('d');
          console.log(`导线${index}:`, netName, pathData);
          if (pathData) {
            const points = this.parsePathData(pathData);
            console.log('解析的坐标点:', points);
            if (points && points.length >= 2) {
              const result = schdocWriter.addWire(points, netName);
              console.log('导线同步结果:', result);
            }
          }
        }
      });
      
      // 同步所有网络标签
      App.netLabels.forEach(label => {
        schdocWriter.addNetLabel(label);
      });
      
      // 同步电源障碍物（转换为电源端口）
      App.powerObstacles.forEach(obstacle => {
        // 这里需要根据实际需求处理电源障碍物
        // 暂时跳过，因为电源障碍物主要用于碰撞检测
      });
      
      console.log('schdoc同步完成:', schdocWriter.getStats());
      console.log('schdoc库统计:', schdocLibrary.getStats());
    } catch (error) {
      console.error('schdoc同步失败:', error);
      toast('schdoc同步失败: ' + error.message, 'error');
    }
  }

  /**
   * 解析SVG路径数据
   */
  parsePathData(pathData) {
    if (!pathData) return null;
    
    const points = [];
    // 修复正则表达式，匹配完整的坐标对
    const commands = pathData.match(/[ML]\s*[\d.-]+\s+[\d.-]+/g);
    
    if (commands) {
      commands.forEach(cmd => {
        const coords = cmd.substring(1).trim().split(/\s+/);
        if (coords.length >= 2) {
          points.push({
            x: parseFloat(coords[0]),
            y: parseFloat(coords[1])
          });
        }
      });
    }
    
    return points.length >= 2 ? points : null;
  }

  /**
   * 元件添加事件
   */
  onComponentAdded(inst) {
    if (!this.enabled) return;
    // 仅标记并统一由 syncToSchdoc 全量重建，避免重复添加
    this.pendingUpdates.add(`component_${inst.id}`);
    this.scheduleUpdate();
  }

  /**
   * 元件移动事件
   */
  onComponentMoved(inst) {
    if (!this.enabled) return;
    // 不直接写入，统一重建
    this.pendingUpdates.add(`component_${inst.id}`);
    this.scheduleUpdate();
  }

  /**
   * 元件删除事件
   */
  onComponentRemoved(instId) {
    if (!this.enabled) return;
    
    // 重新同步所有元件
    this.pendingUpdates.add('components_array');
    this.scheduleUpdate();
  }

  /**
   * 导线添加事件
   */
  onWireAdded(wire, netName) {
    if (!this.enabled) return;
    // 仅标记，统一由全量重建生成导线
    this.pendingUpdates.add(`wire_${App.wires.length - 1}`);
    this.scheduleUpdate();
  }

  /**
   * 网络标签添加事件
   */
  onNetLabelAdded(label) {
    if (!this.enabled) return;
    // 仅标记，统一重建
    this.pendingUpdates.add(`netlabel_${App.netLabels.length - 1}`);
    this.scheduleUpdate();
  }

  /**
   * 电源端口添加事件
   */
  onPowerPortAdded(port) {
    if (!this.enabled) return;
    // 仅标记，统一重建
    this.pendingUpdates.add('power_added');
    this.scheduleUpdate();
  }



  /**
   * 导出schdoc文件（异步版本）
   */
  async exportSchdoc(filename) {
    try {
      // 先同步最新数据
      await this.syncToSchdoc();
      
      // 导出文件
      const content = schdocWriter.exportSchdoc(filename);
      
      toast('schdoc文件已导出', 'ok');
      return content;
    } catch (error) {
      console.error('导出schdoc失败:', error);
      toast('导出schdoc失败: ' + error.message, 'error');
      throw error;
    }
  }

  /**
   * 同步功能始终启用，无需控制
   */



  /**
   * 获取同步状态
   */
  getStatus() {
    return {
      enabled: this.enabled,
      pendingUpdates: this.pendingUpdates.size,
      stats: schdocWriter.getStats()
    };
  }

  /**
   * 清理资源
   */
  destroy() {
    if (this.updateTimeout) {
      clearTimeout(this.updateTimeout);
    }
    this.pendingUpdates.clear();
  }
}

// 创建全局实例
export const schdocSync = new SchdocSync();
