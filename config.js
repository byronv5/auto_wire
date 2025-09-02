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