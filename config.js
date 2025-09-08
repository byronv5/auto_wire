/* ===== 参数配置 ===== */
export const GRID=10, WIRE_WIDTH=2, JUNCTION_RADIUS = 2.5;
export const DEFAULT_VB={x:0,y:0,w:1500,h:950};
export const AVOID_CLEARANCE=4;
export const ROUTE_CLEARANCE=8; 
export const TRUNK_EXTRA=12;
export const POWER_STUB=20;
export const POWER_STUB_IC=30;
export const POWER_TRI_W=12, POWER_TRI_H=12, GND_W=20, GND_H=14;
export const ROUTE_STUB=18;
export const ROUTE_STUB_IC=36;
export const TRUNK_SCAN_STEPS=24;
export const TURN_PENALTY = 20;
export const BACKWARDS_PENALTY = 10;
export const MAX_WIRE_LENGTH = 1000;
export const LABEL_STUB_INCREMENT = GRID;
export const MAX_LABEL_STUB_LENGTH = ROUTE_STUB * 3;

// Critical component constraints - 优化后的约束参数
export const CRYSTAL_MAX_DISTANCE = 30;   // 晶振到MCU最大距离
export const DECAP_MAX_DISTANCE = 25;     // 去耦电容到电源引脚最大距离（更严格）
export const RESET_MAX_DISTANCE = 35;     // 复位电路元件最大距离
export const CORE_MARGIN = 24;            // 核心元件周围边距
export const DECAP_PRIORITY_DISTANCE = 15; // 去耦电容优先放置距离

export const PERIPH_SCAN_STEPS = 60;
export const PLACE_SCAN_STEP = GRID;
export const CLUSTER_RING_BASE = 140;   
export const CLUSTER_RING_STEP = 100;   
export const CLUSTER_LOCAL_SPACING = 28; 
export const EDGE_MARGIN = 20;
export const LOCAL_CLUSTER_RADIUS = 120;

export const LANE_SPACING = 10; 
export const LANE_SPACING_TIGHT = 6; 
export const NET_LOCALITY_THRESHOLD = 250; 
export const LANE_MAX=6;
export const WIRE_OBSTACLE_WIDTH = 4;

// schdoc导出配置
export const SCHDOC_CONFIG = {
  ENABLE_REALTIME_SYNC: true,           // 启用实时同步
  SCHDOC_FILE_PATH: './output/schematic.schdoc', // 默认输出路径
  COORDINATE_SCALE: 1,                  // Canvas单位到schdoc单位的转换比例（1:1映射）
  SHEET_WIDTH: 1000,                    // 与导出Sheet保持一致
  SHEET_HEIGHT: 800,                    // 与导出Sheet保持一致（用于Y轴翻转）
  INVERT_Y: true,                       // 是否Y轴翻转（必要时可关闭，用于排查偏移）
  // 可调锚点微偏移（应用于所有元件的模板整体平移，单位：与 Canvas 同单位）
  COMPONENT_OFFSET_X: 0,
  COMPONENT_OFFSET_Y: 0,
  // 是否启用自动微调（基于引脚-导线），默认关闭，推荐仅用于调试
  AUTO_FINE_ALIGN: false,
  // 基于对比schdoc得到的全局微调（直接使用schdoc坐标增量）
  // 为与“正确”参考文件一致，这里置零，消除系统性偏移
  COMPONENT_BIAS_X: 0,
  COMPONENT_BIAS_Y: 0,
  // 按库引用名的个别修正（覆盖全局偏移），用于消除模板细小取整差
  PER_LIB_BIAS: {
    // 'OP07': { dx: 8, dy: 0 },
    // 'DAC0832': { dx: 10, dy: -1 },
    // 'POT2': { dx: -3, dy: 11 }
  },
  AUTO_SAVE_INTERVAL: 5000,             // 自动保存间隔(ms)
  DEFAULT_COLORS: {
    component: 128,        // #800000
    wire: 8388608,        // #000080
    netLabel: 128,        // #800000
    powerPort: 128,       // #800000
    background: 16317695  // #FFFCF8
  },
  PIN_LENGTHS: {
    default: 10,
    power: 20,
    signal: 15
  },
  POWER_PORT_STYLES: {
    vcc: 7,    // Power
    gnd: 4,    // Ground
    default: 2 // Tee off rail
  }
};