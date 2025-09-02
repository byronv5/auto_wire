import { DEFAULT_VB } from './config.js';

/* ===== App状态管理 ===== */
export const App={
  lib:new Map(), 
  libNorm:new Map(),
  plan:{components:[], nets:[]},
  inst:[], 
  wires:[], 
  netLabels:[], 
  powerObstacles:[],
  cam:{...DEFAULT_VB},
  stats:{totalNets:0,wiredNets:0,labeledNets:0,optimizedComponents:0,criticalCircuits:0},
  byRef:new Map(),
  selectedInst:null,
  segmentLanes:new Map(),
  netStyles:new Map(),
  qualityReport:null,
};