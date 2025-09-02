// [V2.2] 优化版布局引擎 - 改进复位电路识别和放置
import { App } from './state.js';
import { updateQualityIndicator } from './quality.js';
import { $, snap, toast } from './utils.js';
import { AVOID_CLEARANCE, CORE_MARGIN, CRYSTAL_MAX_DISTANCE, DECAP_MAX_DISTANCE, RESET_MAX_DISTANCE, EDGE_MARGIN, PERIPH_SCAN_STEPS, PLACE_SCAN_STEP, CLUSTER_RING_BASE, CLUSTER_RING_STEP, CLUSTER_LOCAL_SPACING, DECAP_PRIORITY_DISTANCE, GRID } from './config.js';
import { effSize, detectType, isConnector, pinAbsByNumber, sideOfPinOnInst, isPowerName, isGndName, isResetName } from './component.js';
import { rectForInst, rectsOverlap } from './geometry.js';

// 新增：复位电路专用的较小间距
const RESET_CIRCUIT_CLEARANCE = 2;
const RESET_COMPONENT_SPACING = 3; // 复位电路元件之间的间距

/* ===== 布局引擎 ===== */
class RNG {
    constructor(seed = 42) {
        this.seed = (seed >>> 0) || 42;
    }
    next() {
        this.seed = (1664525 * this.seed + 1013904223) >>> 0;
        return this.seed / 4294967296;
    }
    uniform(a, b) {
        return a + (b - a) * this.next();
    }
    choice(a) {
        return a[Math.floor(this.next() * a.length)]
    }
}



// 增强版布局引擎 - 优化复位电路识别和放置
export class PlacementEngine {
    constructor(instances, plan, W, H) {
        this.instances = instances;
        this.plan = plan;
        this.W = W;
        this.H = H;
        this.byRef = new Map(instances.map(i => [i.ref, i]));
        this.netList = (plan.nets || []).map(n => ({ name: n.name || '', nodes: (n.nodes || []).filter(Boolean) }));
        this.netsByName = new Map(this.netList.map(n => [n.name, n]));
        this.refToNets = new Map();
        this.adj = new Map();
        this.placedRects = [];
        this.fixedRefs = new Set();
        this.buildConnectivity();
        this.debugMode = false;
    }

    /**
       * [最终修复] 新的顶层调度函数
       * 调整了布局顺序，确保关键外围电路优先于连接器等全局元件。
       */
    runHierarchicalLayout() {



        // 阶段 0: 全局分析与分类
        this.analyzeAndClassifyComponents();

        // 阶段 1: 放置核心
        const core = this.layoutPlan.primaryCore;
        this.centerCore(core);

        // 阶段 2: 详细布局 (现在包含所有元件的放置)
        this.runDetailedPlacement();


        // 阶段 3: 布局验证与优化
        this.validatePlacement();  // 调用已有的验证函数
    }

    /**
     * @description [阶段 0] 分析所有元件，进行分类和归属识别。
     */
    /**
     * @description [阶段 0] 分析所有元件，进行分类和归属识别。
     */
    analyzeAndClassifyComponents() {
        this.layoutPlan = {
            primaryCore: null,
            secondaryCores: [],
            boundary: { inputs: [], outputs: [] },
            clustersByCore: new Map(),
            decouplingCapsByCore: new Map(),
            allCores: [],
            repeatedGroups: [], // 新增：存储重复组
            busAwareGroups: []  // 新增：存储总线意识组
        };

        // 1. 识别主核心和次核心
        this.layoutPlan.primaryCore = this.chooseCore();
        this.instances.forEach(inst => {
            if (detectType(inst) === 'IC' && inst.ref !== this.layoutPlan.primaryCore.ref) {
                this.layoutPlan.secondaryCores.push(inst);
            }
            if (isConnector(inst)) {
                const type = this.classifyConnector(inst);
                if (type === 'INPUT' || type === 'POWER' || type === 'COMM') {
                    this.layoutPlan.boundary.inputs.push(inst);
                } else {
                    this.layoutPlan.boundary.outputs.push(inst);
                }
            }
        });

        this.layoutPlan.allCores = [this.layoutPlan.primaryCore, ...this.layoutPlan.secondaryCores];


        // 2. 为所有核心查找去耦电容
        for (const core of this.layoutPlan.allCores) {
            const caps = this.findDecouplingCaps(core);
            this.layoutPlan.decouplingCapsByCore.set(core.ref, caps);

        }

        // 新增3: 扩展重复电路识别（移动到此处，确保在IO簇之前识别）
        const repeatedGroups = this.identifyRepeatedCircuits(this.layoutPlan.primaryCore);
        this.layoutPlan.repeatedGroups = repeatedGroups;


        // 新增4: 总线意识分组（识别共享GND/VCC的组，并标记方向）
        const busAwareGroups = this.identifyBusAwareGroups();
        this.layoutPlan.busAwareGroups = busAwareGroups;


        // 新增5: 信号流向分类（为每个元件添加direction属性）
        this.instances.forEach(inst => {
            inst.direction = this.classifySignalDirection(inst);
        });

        // 新增6: 为总线意识组计算路径（用于布线对齐）
        this.layoutPlan.busAwareGroups.forEach(group => {
            const xs = group.components.map(c => c.x);
            const ys = group.components.map(c => c.y);
            const minX = Math.min(...xs), maxX = Math.max(...xs);
            const minY = Math.min(...ys), maxY = Math.max(...ys);
            const avgX = (minX + maxX) / 2;
            const avgY = (minY + maxY) / 2;

            // 计算路径：假设为水平/垂直总线
            if (group.alignment === 'horizontal') {
                group.path = [{ x: minX - 10, y: avgY }, { x: maxX + 10, y: avgY }];
            } else if (group.alignment === 'vertical') {
                group.path = [{ x: avgX, y: minY - 10 }, { x: avgX, y: maxY + 10 }];
            } else {
                group.path = [{ x: avgX, y: avgY }];  // 默认单点
            }

        });

    }

    /**
     * @description [阶段 1] 执行宏观布局，确定主要功能区和大型元件的位置。
     */
    performFloorplanning() {
        const boardWidth = this.W;
        const boardHeight = this.H;

        // 1. 放置主核心在中心
        const core = this.layoutPlan.primaryCore;
        this.centerCore(core);


        // 2. 定义区域
        const leftZone = { x: EDGE_MARGIN, y: EDGE_MARGIN, w: boardWidth * 0.3, h: boardHeight - 2 * EDGE_MARGIN };
        const rightZone = { x: boardWidth * 0.7, y: EDGE_MARGIN, w: boardWidth * 0.3 - EDGE_MARGIN, h: boardHeight - 2 * EDGE_MARGIN };
        const coreBox = rectForInst(core); // [FIXED] 使用已有的 rectForInst

        // 3. 放置边界元件和次核心
        this.layoutPlan.boundary.inputs.forEach(inst => this.placeInZone(inst, leftZone, [coreBox]));
        this.layoutPlan.boundary.outputs.forEach(inst => this.placeInZone(inst, rightZone, [coreBox]));

        this.layoutPlan.secondaryCores.forEach(inst => {
            this.placeInZone(inst, rightZone, [coreBox]);

        });
    }

    placeInZone(inst, zone, initialObstacles = []) {
        if (this.fixedRefs.has(inst.ref)) return true;
        const step = 10;
        const s = effSize(inst);

        for (let y = zone.y; y < zone.y + zone.h - s.h; y += step) {
            for (let x = zone.x; x < zone.x + zone.w - s.w; x += step) {
                inst.x = x;
                inst.y = y;
                const testRect = rectForInst(inst);

                let hasCollisionWithInitial = initialObstacles.some(obs => rectsOverlap(testRect, obs));
                if (hasCollisionWithInitial) continue;

                if (!this.collidesRect(testRect)) { // [FIXED] 使用 collidesRect
                    this.setInstPos(inst, x, y);
                    this.addPlaced(inst);

                    return true;
                }
            }
        }

        return false;
    }

    /**
       * 详细布局总调度函数
       * 1. 放置关键电路
       * 2. 放置重复电路
       * 3. 放置IO簇
       * 4. 放置剩余功能簇
       * 5. 最后放置连接器
       */
    runDetailedPlacement() {
        const primaryCore = this.layoutPlan.primaryCore;

        // 步骤 1: 放置主核心的高优先级外围电路
        this.placeCriticalPeripherals(primaryCore);

        // 步骤 2: 放置重复电路组（使用增强版）

        const repeatedGroups = this.layoutPlan.repeatedGroups;  // 从analyzeAndClassifyComponents中获取
        const claimedByRepeated = new Set();
        for (const group of repeatedGroups) {
            if (this.placeRepeatedCircuitGroup(primaryCore, group)) {
                group.circuits.forEach(c => c.circuit.components.forEach(comp => claimedByRepeated.add(comp.ref)));
            }
        }


        // 步骤 3: 放置主核心的剩余IO功能簇（使用增强版）

        const ioClusters = this.findIOClusters(primaryCore, claimedByRepeated);
        for (const cluster of ioClusters) {
            if (cluster.all.some(c => this.fixedRefs.has(c.ref))) continue;
            this.placeIOCluster(primaryCore, cluster);
        }


        // 步骤 4: 放置所有次核心的外围电路
        for (const secondary of this.layoutPlan.secondaryCores) {

            const caps = this.layoutPlan.decouplingCapsByCore.get(secondary.ref) || [];
            for (const decapInfo of caps) {
                if (this.fixedRefs.has(decapInfo.inst.ref)) continue;
                this.placeDecouplingCapEnhanced(secondary, decapInfo);
            }

        }

        // 步骤 5: 放置所有剩余的、未被认领的元件

        this.placeFunctionalClusters(primaryCore);


        // 步骤 6: [关键] 最后放置连接器

        this.placeConnectors();


        // 步骤 7: 最终布局验证

        this.validatePlacement();

    }

    buildConnectivity() {
        this.adj.clear();
        this.refToNets.clear();
        const addEdge = (a, b) => {
            if (!this.adj.has(a)) this.adj.set(a, new Map());
            const m = this.adj.get(a);
            m.set(b, (m.get(b) || 0) + 1);
        };
        for (const net of this.netList) {
            const refs = [...new Set(net.nodes.map(nd => nd.ref).filter(r => this.byRef.has(r)))];
            refs.forEach(r => {
                if (!this.refToNets.has(r)) this.refToNets.set(r, []);
                this.refToNets.get(r).push(net);
            });
            for (let i = 0; i < refs.length; i++) {
                for (let j = i + 1; j < refs.length; j++) {
                    addEdge(refs[i], refs[j]);
                    addEdge(refs[j], refs[i]);
                }
            }
        }
    }

    degree(ref) {
        let s = 0;
        const m = this.adj.get(ref) || new Map();
        for (const v of m.values()) s += v;
        return s;
    }

    neighbors(ref) {
        return [...(this.adj.get(ref) || new Map()).keys()];
    }

    netsOfRef(ref) {
        return this.refToNets.get(ref) || [];
    }

    chooseCore() {
        const all = this.instances.slice();
        const withType = all.map(i => ({ i, tp: detectType(i), deg: this.degree(i.ref) }));
        const mcus = withType.filter(x => x.tp === 'MCU');
        if (mcus.length) {
            mcus.sort((a, b) => b.deg - a.deg);
            return mcus[0].i;
        }
        const ics = withType.filter(x => x.tp === 'IC');
        if (ics.length) {
            ics.sort((a, b) => b.deg - a.deg);
            return ics[0].i;
        }
        if (withType.length) {
            withType.sort((a, b) => b.deg - a.deg);
            return withType[0].i;
        }
        return null;
    }

    sizeForAngle(inst, angle) {
        const w = inst.symbol.w, h = inst.symbol.h;
        angle = ((angle % 360) + 360) % 360;
        return (angle === 0 || angle === 180) ? { w, h } : { w: h, h: w };
    }

    addPlaced(inst, group = null) {
        const rect = rectForInst(inst);
        rect.group = group; // 添加组标识，用于同组元件的特殊碰撞检测
        this.placedRects.push(rect);
        this.fixedRefs.add(inst.ref);
    }

    // 修复后的 collidesRect (添加参数检查)
    collidesRect(test, ignoreGroup = null, useReducedClearance = false) {
        // 参数检查
        if (!test || typeof test.x !== 'number' || typeof test.y !== 'number') {
            return false;
        }

        return this.placedRects.some(r => {
            // 特殊处理：如果是去耦电容的碰撞检测，使用更激进的策略
            if (useReducedClearance) {
                // 对于去耦电容，允许更紧密的放置
                const veryTightTest = {
                    x: test.x + 2,  // 只保留2px的最小间距
                    y: test.y + 2,
                    w: test.w - 4,
                    h: test.h - 4
                };
                return rectsOverlap(r, veryTightTest);
            }
            if (ignoreGroup === 'bus-ready') {
                const busTest = { x: test.x + 2, y: test.y + 2, w: test.w - 4, h: test.h - 4 };
                return rectsOverlap(r, busTest);
            }
            // 原有的碰撞检测逻辑
            if (ignoreGroup && r.group === ignoreGroup) {
                const tightTest = {
                    x: test.x + 1,
                    y: test.y + 1,
                    w: test.w - 2,
                    h: test.h - 2
                };
                return rectsOverlap(r, tightTest);
            }

            return rectsOverlap(r, test);
        });
    }
    withinCanvas(x, y, w, h) {
        return x >= EDGE_MARGIN && y >= EDGE_MARGIN && (x + w) <= this.W - EDGE_MARGIN && (y + h) <= this.H - EDGE_MARGIN;
    }

    setInstPos(inst, x, y) {
        inst.x = snap(x);
        inst.y = snap(y);
    }

    centerCore(inst) {
        const s = effSize(inst);
        const cx = snap(this.W / 2 - s.w / 2), cy = snap(this.H / 2 - s.h / 2);
        this.setInstPos(inst, cx, cy);
        this.addPlaced(inst);
    }
    placeCriticalPeripherals(core) {

        let criticalCount = 0;

        // 步骤1：放置MCU自身的去耦电容

        const decaps = this.layoutPlan.decouplingCapsByCore.get(core.ref) || [];
        for (const decapInfo of decaps) {
            if (this.fixedRefs.has(decapInfo.inst.ref)) continue;
            const placed = this.placeDecouplingCapEnhanced(core, decapInfo);
            if (placed) {
                criticalCount++;

            }
        }

        // 步骤2：放置晶振电路

        const xtalGroups = this.findCrystalGroups(core);
        xtalGroups.forEach((g) => {
            if (!this.fixedRefs.has(g.crystal.ref)) {
                if (this.placeCrystalGroup(core, g)) {
                    criticalCount += (1 + g.caps.length);
                    console.log(`  -> 晶振组 ${g.crystal.ref} 放置成功`);
                }
            }
        });

        // 步骤3：放置复位电路
        console.log(`[关键外围电路] 步骤3: 放置复位电路`);
        const resetCircuits = this.findResetCircuit(core);
        resetCircuits.forEach((rc) => {
            if (this.placeResetCircuit(core, rc)) {
                if (rc.resistor && !this.fixedRefs.has(rc.resistor.ref)) criticalCount++;
                if (rc.capacitor && !this.fixedRefs.has(rc.capacitor.ref)) criticalCount++;
                console.log(`  -> 复位电路 (R=${rc.resistor?.ref}, C=${rc.capacitor?.ref}) 放置成功`);
            }
        });

        console.log(`%c[关键外围电路] 完成！共放置 ${criticalCount} 个高优先级元件`, 'color: green; font-weight: bold;');

        App.stats.criticalCircuits = criticalCount;
        return criticalCount;
    }

    anchorOnCore(core, net) {
        const nodes = (net?.nodes || []).filter(nd => nd.ref === core.ref);
        if (!nodes.length) return null;
        const points = [];
        const sides = [];
        for (const nd of nodes) {
            const pt = pinAbsByNumber(core, nd.pin);
            if (pt) {
                points.push(pt);
                sides.push(sideOfPinOnInst(core, pt));
            }
        }
        if (!points.length) return null;
        const side = ['left', 'right', 'top', 'bottom']
            .map(s => ({ s, c: sides.filter(x => x === s).length }))
            .sort((a, b) => b.c - a.c)[0].s;
        return { side, points };
    }

    chooseRotForSide(inst, side) {
        const w = inst.symbol.w, h = inst.symbol.h;
        const wantParallelLong = (side === 'left' || side === 'right') ? 'vertical' : 'horizontal';
        if (wantParallelLong === 'vertical') {
            return (h >= w) ? 0 : 90;
        } else {
            return (w >= h) ? 0 : 90;
        }
    }

    tryPlaceNearCoreSide(core, side, anchorPoints, inst, maxDistance = 100) {
        const coreSize = effSize(core);
        let angle = this.chooseRotForSide(inst, side);
        const axisCoords = (side === 'left' || side === 'right') ? anchorPoints.map(p => p.y) : anchorPoints.map(p => p.x);
        const axisCenter = snap(axisCoords.sort((a, b) => a - b)[Math.floor((axisCoords.length - 1) / 2)]);

        for (const ang of [angle, (angle + 90) % 360]) {
            inst.rot = ang;
            const s = this.sizeForAngle(inst, inst.rot);
            for (let step = 0; step < PERIPH_SCAN_STEPS; step++) {
                for (const dir of [1, -1]) {
                    const delta = step * PLACE_SCAN_STEP * dir;
                    let x = 0, y = 0;
                    if (side === 'left') {
                        x = core.x - CORE_MARGIN - s.w;
                        y = axisCenter + delta - s.h / 2;
                    } else if (side === 'right') {
                        x = core.x + coreSize.w + CORE_MARGIN;
                        y = axisCenter + delta - s.h / 2;
                    } else if (side === 'top') {
                        x = axisCenter + delta - s.w / 2;
                        y = core.y - CORE_MARGIN - s.h;
                    } else {
                        x = axisCenter + delta - s.w / 2;
                        y = core.y + coreSize.h + CORE_MARGIN;
                    }
                    x = snap(x); y = snap(y);

                    if (maxDistance < 100) {
                        const dist = Math.hypot(x + s.w / 2 - (core.x + coreSize.w / 2),
                            y + s.h / 2 - (core.y + coreSize.h / 2));
                        if (dist > maxDistance) continue;
                    }

                    const test = { x: x - AVOID_CLEARANCE, y: y - AVOID_CLEARANCE, w: s.w + 2 * AVOID_CLEARANCE, h: s.h + 2 * AVOID_CLEARANCE };
                    if (!this.withinCanvas(x, y, s.w, s.h)) continue;
                    if (!this.collidesRect(test)) {
                        this.setInstPos(inst, x, y);
                        this.addPlaced(inst);
                        return true;
                    }
                }
            }
        }
        return false;
    }

    // 改进：使用更小的间距进行引脚附近放置
    tryPlaceNearPin(pinPos, inst, side, margin = 5, clearance = null) {
        const s = effSize(inst);
        const actualClearance = clearance !== null ? clearance : AVOID_CLEARANCE;

        // 根据引脚所在侧确定放置位置
        const positions = [];

        if (side === 'left') {
            // 元件放在引脚左侧
            positions.push({
                x: pinPos.x - margin - s.w,
                y: pinPos.y - s.h / 2,
                rot: 90
            });
            positions.push({
                x: pinPos.x - margin - s.w,
                y: pinPos.y - s.h / 2,
                rot: 0
            });
        } else if (side === 'right') {
            // 元件放在引脚右侧
            positions.push({
                x: pinPos.x + margin,
                y: pinPos.y - s.h / 2,
                rot: 90
            });
            positions.push({
                x: pinPos.x + margin,
                y: pinPos.y - s.h / 2,
                rot: 0
            });
        } else if (side === 'top') {
            // 元件放在引脚上方
            positions.push({
                x: pinPos.x - s.w / 2,
                y: pinPos.y - margin - s.h,
                rot: 0
            });
            positions.push({
                x: pinPos.x - s.w / 2,
                y: pinPos.y - margin - s.h,
                rot: 90
            });
        } else {
            // 元件放在引脚下方
            positions.push({
                x: pinPos.x - s.w / 2,
                y: pinPos.y + margin,
                rot: 0
            });
            positions.push({
                x: pinPos.x - s.w / 2,
                y: pinPos.y + margin,
                rot: 90
            });
        }

        // 尝试每个位置
        for (const pos of positions) {
            inst.rot = pos.rot;
            const rotatedSize = this.sizeForAngle(inst, inst.rot);
            const x = snap(pos.x);
            const y = snap(pos.y);

            const test = {
                x: x - actualClearance,
                y: y - actualClearance,
                w: rotatedSize.w + 2 * actualClearance,
                h: rotatedSize.h + 2 * actualClearance
            };

            if (this.withinCanvas(x, y, rotatedSize.w, rotatedSize.h) && !this.collidesRect(test)) {
                this.setInstPos(inst, x, y);
                this.addPlaced(inst, 'reset'); // 标记为复位电路组
                return true;
            }
        }

        return false;
    }

    findXTALPins(core) {
        const xtalPins = [];
        const xtalNets = this.netsOfRef(core.ref).filter(net => {
            return net.nodes.some(n => {
                if (n.ref === core.ref) return false;
                const inst = this.byRef.get(n.ref);
                return inst && detectType(inst) === 'Crystal';
            });
        });

        for (const net of xtalNets) {
            const nodes = net.nodes.filter(n => n.ref === core.ref);
            nodes.forEach(n => {
                const pt = pinAbsByNumber(core, n.pin);
                if (pt) xtalPins.push(pt);
            });
        }
        return xtalPins;
    }

    findCrystalGroups(core) {
        const groups = [];
        const refs = this.neighbors(core.ref);
        for (const ref of refs) {
            const inst = this.byRef.get(ref);
            if (!inst) continue;
            if (detectType(inst) !== 'Crystal') continue;
            const coreNets = new Set(this.netsOfRef(core.ref).map(n => n.name));
            const xtalNets = this.netsOfRef(inst.ref).filter(n => n.nodes.some(nd => nd.ref === core.ref));
            if (!xtalNets.length) continue;
            const capCandidates = new Set();
            const gndSet = new Set(this.netList.filter(n => isGndName(n.name)).map(n => n.name));
            for (const net of xtalNets) {
                for (const nd of net.nodes || []) {
                    const otherRef = nd.ref;
                    if (otherRef === core.ref || otherRef === inst.ref) continue;
                    const oInst = this.byRef.get(otherRef);
                    if (!oInst) continue;
                    if (detectType(oInst) === 'Capacitor') {
                        const netsOfCap = this.netsOfRef(oInst.ref).map(n => n.name);
                        const hasGnd = netsOfCap.some(nn => gndSet.has(nn));
                        if (hasGnd) { capCandidates.add(oInst.ref); }
                    }
                }
            }
            const capList = [...capCandidates].slice(0, 2).map(r => this.byRef.get(r)).filter(Boolean);
            // 新增：为电容标记GND网络
            capList.forEach(cap => {
                const nets = this.netsOfRef(cap.ref);
                cap.gndNet = nets.find(n => isGndName(n.name));
            });
            groups.push({ crystal: inst, caps: capList, xtalNets });
        }
        return groups;
    }

    placeCrystalGroup(core, grp) {
        const xtalPins = this.findXTALPins(core);
        if (xtalPins.length === 0) return false;

        const xtalCenter = {
            x: xtalPins.reduce((s, p) => s + p.x, 0) / xtalPins.length,
            y: xtalPins.reduce((s, p) => s + p.y, 0) / xtalPins.length
        };

        const side = sideOfPinOnInst(core, xtalCenter);
        const crystal = grp.crystal;
        const crystalSize = effSize(crystal);
        let crystalX, crystalY;

        const CRYSTAL_MARGIN = 8;

        if (side === 'bottom') {
            crystalX = xtalCenter.x - crystalSize.w / 2;
            crystalY = core.y + effSize(core).h + CRYSTAL_MARGIN;
        } else if (side === 'right') {
            crystalX = core.x + effSize(core).w + CRYSTAL_MARGIN;
            crystalY = xtalCenter.y - crystalSize.h / 2;
        } else if (side === 'top') {
            crystalX = xtalCenter.x - crystalSize.w / 2;
            crystalY = core.y - crystalSize.h - CRYSTAL_MARGIN;
        } else {
            crystalX = core.x - crystalSize.w - CRYSTAL_MARGIN;
            crystalY = xtalCenter.y - crystalSize.h / 2;
        }

        this.setInstPos(crystal, snap(crystalX), snap(crystalY));
        this.addPlaced(crystal, 'crystal'); // 标记为晶振组

        const caps = grp.caps;
        if (caps.length >= 2) {
            const CAP_SPACING = 5;

            // 新增：识别每个电容的GND引脚，并调整旋转使GND向下
            caps.forEach((cap, idx) => {
                cap.rot = 90;  // 默认垂直旋转，便于GND向下
                const capSize = effSize(cap);

                // 识别GND网络（假设电容有两个引脚，一个接GND）
                const capNets = this.netsOfRef(cap.ref);
                const gndNet = capNets.find(n => isGndName(n.name));
                const isGndDown = true;  // 强制GND向下

                let capX, capY;
                if (side === 'bottom' || side === 'top') {
                    capX = crystal.x + (idx === 0 ? -capSize.w - CAP_SPACING : crystalSize.w + CAP_SPACING);
                    capY = crystal.y + crystalSize.h / 2 - capSize.h / 2;
                    if (isGndDown) capY += capSize.h / 2;  // 调整使GND向下
                } else {
                    capX = crystal.x + crystalSize.w / 2 - capSize.w / 2;
                    capY = crystal.y + (idx === 0 ? -capSize.h - CAP_SPACING : crystalSize.h + CAP_SPACING);
                    if (isGndDown) capY += capSize.h;  // 调整使GND向下
                }

                this.setInstPos(cap, snap(capX), snap(capY));
                this.addPlaced(cap, 'crystal');

                // 新增：标记电容的GND引脚方向（用于布线）
                cap.gndDirection = 'down';  // 存储在实例中，供布线使用
            });
        }

        return true;
    }

    // 复位电路识别
    findResetCircuit(core) {
        console.log(`[复位电路识别] 开始搜索复位电路...`);
        const resetCircuits = [];
        if (!core) return resetCircuits;

        // 步骤1: 查找复位引脚
        const potentialPins = [];
        for (let pinNum = 1; pinNum <= (core.pins?.length || 100); pinNum++) {
            const pinData = core.pins.find(p => p.number == pinNum);
            const pinName = (pinData?.name || '').toUpperCase();
            const pt = pinAbsByNumber(core, pinNum);
            if (!pt) continue;

            const connectedNets = this.netsOfRef(core.ref).filter(net =>
                net.nodes.some(n => n.ref === core.ref && n.pin == pinNum)
            );

            // 检查是否是复位引脚
            if (isResetName(pinName) ||
                connectedNets.some(n => isResetName(n.name)) ||
                pinNum === 9 || // 89C51的复位引脚
                pinName.includes('RST') ||
                pinName.includes('RESET')) {

                if (connectedNets.length > 0) {
                    console.log(`找到复位引脚: Pin ${pinNum} (${pinName})`);
                    potentialPins.push({ pin: pinNum, pt, nets: connectedNets });
                }
            }
        }

        // 步骤2: 对每个复位引脚分析连接的元件
        for (const resetPinData of potentialPins) {
            let resetResistor = null;
            let resetCapacitor = null;

            // 获取连接到复位网络的所有元件
            const connectedComponents = [];
            for (const net of resetPinData.nets) {
                for (const node of net.nodes) {
                    if (node.ref === core.ref) continue;
                    const inst = this.byRef.get(node.ref);
                    if (inst) {
                        connectedComponents.push({
                            inst,
                            net: net.name,
                            otherNets: this.netsOfRef(inst.ref).map(n => n.name)
                        });
                    }
                }
            }

            // 识别复位电路元件（不依赖于电源/地的连接方向）
            for (const comp of connectedComponents) {
                const type = detectType(comp.inst);

                if (type === 'Resistor' && !resetResistor) {
                    // 检查电阻是否连接到电源或地
                    const haspower = comp.otherNets.some(n => isPowerName(n));
                    const hasGnd = comp.otherNets.some(n => isGndName(n));

                    if (haspower || hasGnd) {
                        resetResistor = comp.inst;
                        console.log(`识别到复位电阻: ${comp.inst.ref}, 连接到: ${comp.otherNets.join(', ')}`);
                    }
                }

                if (type === 'Capacitor' && !resetCapacitor) {
                    // 检查电容是否连接到电源或地
                    const hasPower = comp.otherNets.some(n => isPowerName(n));
                    const hasGnd = comp.otherNets.some(n => isGndName(n));

                    if (hasPower || hasGnd) {
                        resetCapacitor = comp.inst;
                        console.log(`识别到复位电容: ${comp.inst.ref}, 连接到: ${comp.otherNets.join(', ')}`);
                    }
                }
            }

            // 如果找到了R和C，无论连接方向如何，都认为是复位电路
            if (resetResistor && resetCapacitor) {
                const side = sideOfPinOnInst(core, resetPinData.pt);
                resetCircuits.push({
                    resetNet: resetPinData.nets[0],
                    resetPin: resetPinData.pt,
                    pinNumber: resetPinData.pin,
                    resistor: resetResistor,
                    capacitor: resetCapacitor,
                    otherComponents: [],
                    side: side
                });
                console.log(`成功组装复位电路: R=${resetResistor.ref}, C=${resetCapacitor.ref}`);
            }

            // 降级策略：即使只找到R或C，也尝试放置
            else if (resetResistor || resetCapacitor) {
                const side = sideOfPinOnInst(core, resetPinData.pt);
                resetCircuits.push({
                    resetNet: resetPinData.nets[0],
                    resetPin: resetPinData.pt,
                    pinNumber: resetPinData.pin,
                    resistor: resetResistor,
                    capacitor: resetCapacitor,
                    otherComponents: [],
                    side: side
                });
                console.log(`部分复位电路: R=${resetResistor?.ref || '无'}, C=${resetCapacitor?.ref || '无'}`);
            }
        }

        return resetCircuits;
    }

    placeResetCircuit(core, resetCircuit) {
        const { resetPin, resistor, capacitor } = resetCircuit;



        // 如果只有一个元件，单独处理
        if (!resistor || !capacitor) {
            const single = resistor || capacitor;
            if (this.fixedRefs.has(single.ref)) return false;
            return this.tryPlaceNearPosition(single, resetPin, RESET_MAX_DISTANCE, RESET_CIRCUIT_CLEARANCE);
        }

        // 两个元件都存在时
        if (this.fixedRefs.has(resistor.ref) || this.fixedRefs.has(capacitor.ref)) {
            console.warn(`[C3追踪-警告]: R1或C3在进入placeResetCircuit前已被放置，跳过。`);
            return false;
        }

        // 保存当前状态（用于回滚）
        const savedPlacedRectsLength = this.placedRects.length;


        const placed = this.tryPlaceResetGroup(resistor, capacitor, resetPin);

        if (!placed) {
            // 组放置失败，回滚状态
            this.placedRects.length = savedPlacedRectsLength;
            this.fixedRefs.delete(resistor.ref); // 确保回滚
            this.fixedRefs.delete(capacitor.ref); // 确保回滚

            let resistorPlaced = false;
            let capacitorPlaced = false;

            // 先放置电阻
            resistorPlaced = this.tryPlaceNearPosition(
                resistor, resetPin, RESET_MAX_DISTANCE / 2, RESET_CIRCUIT_CLEARANCE
            );


            // 如果电阻放置成功，尝试在电阻附近放置电容
            if (resistorPlaced) {
                const resistorCenter = {
                    x: resistor.x + effSize(resistor).w / 2,
                    y: resistor.y + effSize(resistor).h / 2
                };

                capacitorPlaced = this.tryPlaceNearPosition(
                    capacitor, resistorCenter, 30, RESET_CIRCUIT_CLEARANCE
                );

            }

            // 如果电容还是放不下，尝试在复位引脚附近放置
            if (!capacitorPlaced) {

                capacitorPlaced = this.tryPlaceNearPosition(
                    capacitor, resetPin, RESET_MAX_DISTANCE, RESET_CIRCUIT_CLEARANCE
                );
            }

            return resistorPlaced || capacitorPlaced;
        }


        return true;
    }

    // 新增辅助函数：尝试组放置
    tryPlaceResetGroup(resistor, capacitor, resetPin) {
        const rSize = effSize(resistor);
        const cSize = effSize(capacitor);
        const spacing = RESET_COMPONENT_SPACING;

        console.log(`[复位组放置] 开始尝试组放置 R:${resistor.ref}, C:${capacitor.ref}`);
        console.log(`[复位组放置] 当前已放置元件数: ${this.placedRects.length}`);

        // 定义多种排列方式
        const arrangements = [
            // 水平排列 (R在左，C在右)
            {
                w: rSize.w + spacing + cSize.w,
                h: Math.max(rSize.h, cSize.h),
                rPos: { x: 0, y: 0 },
                cPos: { x: rSize.w + spacing, y: 0 },
                name: "水平-RC"
            },
            // 垂直排列 (R在上，C在下) 
            {
                w: Math.max(rSize.w, cSize.w),
                h: rSize.h + spacing + cSize.h,
                rPos: { x: 0, y: 0 },
                cPos: { x: 0, y: rSize.h + spacing },
                name: "垂直-RC"
            },
            // 紧凑对角排列
            {
                w: rSize.w + spacing / 2 + cSize.w / 2,
                h: rSize.h + spacing / 2 + cSize.h / 2,
                rPos: { x: 0, y: 0 },
                cPos: { x: rSize.w / 2 + spacing / 2, y: rSize.h / 2 + spacing / 2 },
                name: "对角-RC"
            }
        ];

        // 改进的搜索策略：更密集的搜索网格
        const searchStrategies = [
            // 策略1：近距离密集搜索
            { minR: 5, maxR: 30, stepR: 3, stepAngle: 30 },
            // 策略2：中距离搜索
            { minR: 30, maxR: 60, stepR: 5, stepAngle: 20 },
            // 策略3：远距离搜索
            { minR: 60, maxR: RESET_MAX_DISTANCE, stepR: 8, stepAngle: 15 }
        ];

        for (const arrangement of arrangements) {
            console.log(`[复位组放置] 尝试${arrangement.name}排列`);

            for (const strategy of searchStrategies) {
                for (let r = strategy.minR; r <= strategy.maxR; r += strategy.stepR) {
                    for (let angleDeg = 0; angleDeg < 360; angleDeg += strategy.stepAngle) {
                        const angleRad = angleDeg * Math.PI / 180;

                        // 尝试多个偏移点（不仅仅是中心）
                        const offsets = [
                            { x: arrangement.w / 2, y: arrangement.h / 2 },  // 中心
                            { x: 0, y: 0 },  // 左上角
                            { x: arrangement.w, y: 0 },  // 右上角
                            { x: 0, y: arrangement.h },  // 左下角
                            { x: arrangement.w, y: arrangement.h }  // 右下角
                        ];

                        for (const offset of offsets) {
                            const groupX = snap(resetPin.x + r * Math.cos(angleRad) - offset.x);
                            const groupY = snap(resetPin.y + r * Math.sin(angleRad) - offset.y);

                            const finalRx = groupX + arrangement.rPos.x;
                            const finalRy = groupY + arrangement.rPos.y;
                            const finalCx = groupX + arrangement.cPos.x;
                            const finalCy = groupY + arrangement.cPos.y;

                            // 检查两个元件的位置是否都合法
                            const rRect = {
                                x: finalRx - RESET_CIRCUIT_CLEARANCE,
                                y: finalRy - RESET_CIRCUIT_CLEARANCE,
                                w: rSize.w + 2 * RESET_CIRCUIT_CLEARANCE,
                                h: rSize.h + 2 * RESET_CIRCUIT_CLEARANCE
                            };

                            const cRect = {
                                x: finalCx - RESET_CIRCUIT_CLEARANCE,
                                y: finalCy - RESET_CIRCUIT_CLEARANCE,
                                w: cSize.w + 2 * RESET_CIRCUIT_CLEARANCE,
                                h: cSize.h + 2 * RESET_CIRCUIT_CLEARANCE
                            };

                            // 检查是否在画布内
                            if (!this.withinCanvas(finalRx, finalRy, rSize.w, rSize.h) ||
                                !this.withinCanvas(finalCx, finalCy, cSize.w, cSize.h)) {
                                continue;
                            }

                            // 检查碰撞（使用更宽松的碰撞检测）
                            if (!this.collidesRect(rRect, 'reset') &&
                                !this.collidesRect(cRect, 'reset')) {

                                // 成功找到位置
                                console.log(`[复位组放置] 成功！使用${arrangement.name}排列`);
                                console.log(`[复位组放置] R1:(${finalRx},${finalRy}), C3:(${finalCx},${finalCy})`);

                                this.setInstPos(resistor, finalRx, finalRy);
                                this.setInstPos(capacitor, finalCx, finalCy);
                                this.addPlaced(resistor, 'reset');
                                this.addPlaced(capacitor, 'reset');
                                return true;
                            }
                        }
                    }
                }
            }
        }

        console.log(`[复位组放置] 所有尝试失败，将使用降级策略`);
        return false;
    }

    // ... (文件后面的代码保持不变) ...

    tryPlaceNearPosition(inst, targetPos, maxDistance, clearance = null) {
        inst.rot = 0;
        const s = effSize(inst);
        const actualClearance = clearance !== null ? clearance : AVOID_CLEARANCE;

        for (let r = GRID; r <= maxDistance; r += GRID) {
            for (let angle = 0; angle < Math.PI * 2; angle += Math.PI / 8) {
                const x = snap(targetPos.x + r * Math.cos(angle) - s.w / 2);
                const y = snap(targetPos.y + r * Math.sin(angle) - s.h / 2);

                const test = {
                    x: x - actualClearance,
                    y: y - actualClearance,
                    w: s.w + 2 * actualClearance,
                    h: s.h + 2 * actualClearance
                };

                if (this.withinCanvas(x, y, s.w, s.h) && !this.collidesRect(test, 'reset')) {
                    this.setInstPos(inst, x, y);
                    this.addPlaced(inst, 'reset');
                    return true;
                }
            }
        }
        return false;
    }

    findDecouplingCaps(core) {
        console.log(`%c[去耦电容识别] ========== 开始识别去耦电容 ==========`, 'background: #e0f2fe; color: #0369a1; font-weight: bold;');

        const powerPins = [];
        const powerNets = this.netsOfRef(core.ref).filter(n => isPowerName(n.name));

        console.log(`[去耦电容识别] 核心元件 ${core.ref} 的电源网络: ${powerNets.map(n => n.name).join(', ') || '无'}`);

        // 收集所有电源引脚
        powerNets.forEach(net => {
            net.nodes.filter(n => n.ref === core.ref).forEach(node => {
                const pt = pinAbsByNumber(core, node.pin);
                if (pt) {
                    powerPins.push({
                        ...pt,
                        net: net.name,
                        pin: node.pin,
                        pinNumber: node.pin,
                        parentInst: core,
                        parentRef: core.ref
                    });
                    console.log(`[去耦电容识别] 发现电源引脚: Pin ${node.pin} at (${pt.x.toFixed(1)}, ${pt.y.toFixed(1)}), 网络: ${net.name}`);
                }
            });
        });

        // 查找驱动IC的电源引脚
        const driverICs = this.instances.filter(i => {
            const type = detectType(i);
            return type === 'IC' && i.ref !== core.ref &&
                (i.ref.includes('ULN') || i.ref.includes('L293') || i.ref.includes('L298') ||
                    i.value?.includes('driver') || i.value?.includes('2003'));
        });

        console.log(`[去耦电容识别] 发现 ${driverICs.length} 个驱动IC: ${driverICs.map(d => d.ref).join(', ')}`);

        driverICs.forEach(driver => {
            const driverPowerNets = this.netsOfRef(driver.ref).filter(n => isPowerName(n.name));
            driverPowerNets.forEach(net => {
                net.nodes.filter(n => n.ref === driver.ref).forEach(node => {
                    const pt = pinAbsByNumber(driver, node.pin);
                    if (pt) {
                        powerPins.push({
                            ...pt,
                            net: net.name,
                            pin: node.pin,
                            pinNumber: node.pin,
                            parentInst: driver,
                            parentRef: driver.ref
                        });
                    }
                });
            });
        });

        const gndNames = new Set(this.netList.filter(n => isGndName(n.name)).map(n => n.name));
        const decaps = [];
        const seen = new Set();

        const allCaps = [];

        // 遍历所有电源网络来寻找连接的电容
        for (const pnet of this.netList.filter(n => isPowerName(n.name))) {
            for (const nd of pnet.nodes || []) {
                const ref = nd.ref;
                const inst = this.byRef.get(ref);
                if (!inst || detectType(inst) !== 'Capacitor' || seen.has(inst.ref)) continue;

                const netsOfCap = this.netsOfRef(inst.ref).map(n => n.name);
                const hasGnd = netsOfCap.some(nn => gndNames.has(nn));
                const hasPower = netsOfCap.includes(pnet.name);

                if (hasPower && hasGnd) {
                    const val = (inst.value || '').toLowerCase();
                    const isDecouplingValue = val.includes('100n') || val.includes('0.1u') ||
                        val.includes('104') || val.includes('0.1') ||
                        val.includes('cap') || val === 'c' || val === '' || !val;

                    if (isDecouplingValue) {
                        allCaps.push({ inst, powerNet: pnet.name });
                        seen.add(inst.ref);
                        console.log(`[去耦电容识别] 识别到去耦电容: ${inst.ref}, 值: ${val || '(空)'}, 网络: ${pnet.name}`);
                    }
                }
            }
        }

        // 为每个去耦电容找到最近的电源引脚
        allCaps.forEach(cap => {
            let nearestPin = null;
            let minDist = Infinity;
            let targetInst = core;

            powerPins.forEach(pin => {
                if (pin.net === cap.powerNet) {
                    const dist = Math.hypot(pin.x - (cap.inst.x || 0), pin.y - (cap.inst.y || 0));
                    if (dist < minDist) {
                        minDist = dist;
                        nearestPin = pin;
                        if (pin.parentInst) {
                            targetInst = pin.parentInst;
                        }
                    }
                }
            });

            if (nearestPin) {
                // 计算优先级（距离越近优先级越高）
                const priority = minDist < 50 ? 1 : (minDist < 100 ? 2 : 3);

                decaps.push({
                    inst: cap.inst,
                    anchorNet: { name: cap.powerNet },
                    targetPin: nearestPin,
                    targetInst: targetInst,
                    distance: minDist,
                    priority: priority
                });
            }
        });

        // 按优先级和距离排序
        decaps.sort((a, b) => {
            if (a.priority !== b.priority) return a.priority - b.priority;
            return a.distance - b.distance;
        });

        console.log(`[去耦电容识别] 共识别 ${decaps.length} 个去耦电容`);
        console.log(`[去耦电容识别] 优先级1(近距离): ${decaps.filter(d => d.priority === 1).map(d => d.inst.ref).join(', ')}`);
        console.log(`[去耦电容识别] 优先级2(中距离): ${decaps.filter(d => d.priority === 2).map(d => d.inst.ref).join(', ')}`);
        console.log(`[去耦电容识别] 优先级3(远距离): ${decaps.filter(d => d.priority === 3).map(d => d.inst.ref).join(', ')}`);

        return decaps;
    }
    placeDecouplingCapEnhanced(core, decapInfo) {
        const { inst, targetPin, targetInst } = decapInfo;

        if (!targetPin) {
            console.error(`[${inst.ref}放置-增强版] 错误：targetPin为空`);
            return false;
        }   

        // 使用专门的去耦电容间距
        const DECAP_CLEARANCE = 1; // 更小的间距
        const DECAP_PIN_DISTANCE = 3; // 与引脚的距离

        const side = sideOfPinOnInst(targetInst, targetPin);
        const s = effSize(inst);

        // 策略1：垂直于引脚方向放置（最优先）


        const verticalPositions = [];
        if (side === 'right' || side === 'left') {
            // 引脚在左右侧，尝试上下放置
            verticalPositions.push(
                { x: targetPin.x - s.w / 2, y: targetPin.y - s.h - DECAP_PIN_DISTANCE, rot: 0, desc: '正上方' },
                { x: targetPin.x - s.w / 2, y: targetPin.y + DECAP_PIN_DISTANCE, rot: 0, desc: '正下方' },
                { x: targetPin.x - s.w / 2 - 5, y: targetPin.y - s.h - DECAP_PIN_DISTANCE, rot: 0, desc: '左上方' },
                { x: targetPin.x - s.w / 2 + 5, y: targetPin.y - s.h - DECAP_PIN_DISTANCE, rot: 0, desc: '右上方' }
            );
        } else {
            // 引脚在上下侧，尝试左右放置
            verticalPositions.push(
                { x: targetPin.x - s.w - DECAP_PIN_DISTANCE, y: targetPin.y - s.h / 2, rot: 90, desc: '正左方' },
                { x: targetPin.x + DECAP_PIN_DISTANCE, y: targetPin.y - s.h / 2, rot: 90, desc: '正右方' },
                { x: targetPin.x - s.w - DECAP_PIN_DISTANCE, y: targetPin.y - s.h / 2 - 5, rot: 90, desc: '左上方' },
                { x: targetPin.x - s.w - DECAP_PIN_DISTANCE, y: targetPin.y - s.h / 2 + 5, rot: 90, desc: '左下方' }
            );
        }

        for (const pos of verticalPositions) {
            inst.rot = pos.rot;
            const rotatedSize = this.sizeForAngle(inst, inst.rot);
            const x = snap(pos.x);
            const y = snap(pos.y);

            const test = {
                x: x - DECAP_CLEARANCE,
                y: y - DECAP_CLEARANCE,
                w: rotatedSize.w + 2 * DECAP_CLEARANCE,
                h: rotatedSize.h + 2 * DECAP_CLEARANCE
            };

            // 检查画布边界
            const withinCanvas = this.withinCanvas(x, y, rotatedSize.w, rotatedSize.h);

            // 检查碰撞
            const collides = this.collidesRect(test, 'decoupling', true);
            if (this.withinCanvas(x, y, rotatedSize.w, rotatedSize.h) && !collides) {
                this.setInstPos(inst, x, y);
                this.addPlaced(inst, 'decoupling');
                return true;
            }

            if (withinCanvas && !collides) {
                this.setInstPos(inst, x, y);
                this.addPlaced(inst, 'decoupling');
                return true;
            }
        }

        // 策略2：沿引脚方向偏移放置


        const parallelPositions = [];
        if (side === 'right') {
            parallelPositions.push(
                { x: targetPin.x + DECAP_PIN_DISTANCE, y: targetPin.y - s.h / 2, rot: 90, desc: '右侧' },
                { x: targetPin.x + DECAP_PIN_DISTANCE + 5, y: targetPin.y - s.h / 2, rot: 90, desc: '右侧偏移' }
            );
        } else if (side === 'left') {
            parallelPositions.push(
                { x: targetPin.x - s.w - DECAP_PIN_DISTANCE, y: targetPin.y - s.h / 2, rot: 90, desc: '左侧' },
                { x: targetPin.x - s.w - DECAP_PIN_DISTANCE - 5, y: targetPin.y - s.h / 2, rot: 90, desc: '左侧偏移' }
            );
        } else if (side === 'top') {
            parallelPositions.push(
                { x: targetPin.x - s.w / 2, y: targetPin.y - s.h - DECAP_PIN_DISTANCE, rot: 0, desc: '上方' },
                { x: targetPin.x - s.w / 2, y: targetPin.y - s.h - DECAP_PIN_DISTANCE - 5, rot: 0, desc: '上方偏移' }
            );
        } else {
            parallelPositions.push(
                { x: targetPin.x - s.w / 2, y: targetPin.y + DECAP_PIN_DISTANCE, rot: 0, desc: '下方' },
                { x: targetPin.x - s.w / 2, y: targetPin.y + DECAP_PIN_DISTANCE + 5, rot: 0, desc: '下方偏移' }
            );
        }

        for (const pos of parallelPositions) {
            inst.rot = pos.rot;
            const rotatedSize = this.sizeForAngle(inst, inst.rot);
            const x = snap(pos.x);
            const y = snap(pos.y);

            const test = {
                x: x - DECAP_CLEARANCE,
                y: y - DECAP_CLEARANCE,
                w: rotatedSize.w + 2 * DECAP_CLEARANCE,
                h: rotatedSize.h + 2 * DECAP_CLEARANCE
            };

            if (this.withinCanvas(x, y, rotatedSize.w, rotatedSize.h) && !this.collidesRect(test, 'decoupling')) {
                this.setInstPos(inst, x, y);
                this.addPlaced(inst, 'decoupling');
                return true;
            }
        }

        // 策略3：环形搜索（扩大搜索范围）
        for (let r = DECAP_PIN_DISTANCE; r <= 30; r += 3) {
            const angleStep = Math.min(30, 360 / (2 * Math.PI * r / 10)); // 自适应角度步长

            for (let angleDeg = 0; angleDeg < 360; angleDeg += angleStep) {
                const angleRad = angleDeg * Math.PI / 180;
                const testX = targetPin.x + r * Math.cos(angleRad) - s.w / 2;
                const testY = targetPin.y + r * Math.sin(angleRad) - s.h / 2;

                for (const rotation of [0, 90]) {
                    inst.rot = rotation;
                    const rotatedSize = this.sizeForAngle(inst, inst.rot);
                    const x = snap(testX);
                    const y = snap(testY);

                    const test = {
                        x: x - DECAP_CLEARANCE,
                        y: y - DECAP_CLEARANCE,
                        w: rotatedSize.w + 2 * DECAP_CLEARANCE,
                        h: rotatedSize.h + 2 * DECAP_CLEARANCE
                    };

                    if (this.withinCanvas(x, y, rotatedSize.w, rotatedSize.h) && !this.collidesRect(test, 'decoupling')) {
                        this.setInstPos(inst, x, y);
                        this.addPlaced(inst, 'decoupling');
                        return true;
                    }
                }
            }
        }

        const fallbackResult = this.tryPlaceNearCoreSide(targetInst, side, [targetPin], inst, DECAP_MAX_DISTANCE);
        return fallbackResult;
    }

    placeDecouplingCap(core, decapInfo) {
        const { inst, targetPin } = decapInfo;
        const isC4 = inst.ref === 'C4';
        if (isC4) {

            if (!targetPin) {

                return false;
            }
            console.log(`%c  - 目标IC: ${core.ref}`, 'color: blue;');
            console.log(`%c  - 目标引脚: ${targetPin.pinNumber} at (${targetPin.x.toFixed(1)}, ${targetPin.y.toFixed(1)})`, 'color: blue;');
        }

        if (!targetPin) return false;

        const side = sideOfPinOnInst(core, targetPin);
        if (isC4) console.log(`%c  - 判断出的引脚所在侧: ${side}`, 'color: blue;');

        // 优先尝试直接贴近引脚

        const placedNearPin = this.tryPlaceNearPin(targetPin, inst, side, 5, AVOID_CLEARANCE);
        if (isC4) console.log(`%c  - 策略1结果: ${placedNearPin ? '成功' : '失败'}`, placedNearPin ? 'color: green;' : 'color: orange;');
        if (placedNearPin) {
            return true;
        }

        // 备用策略

        if (side === 'left' || side === 'right') {
            inst.rot = 90;
        } else {
            inst.rot = 0;
        }

        const s = effSize(inst);

        const strategies = [
            { distance: 5, offsetX: 0, offsetY: 0 },
            { distance: 8, offsetX: GRID / 2, offsetY: 0 },
            { distance: 12, offsetX: 0, offsetY: GRID / 2 },
            { distance: DECAP_PRIORITY_DISTANCE, offsetX: GRID, offsetY: 0 }
        ];

        for (const strategy of strategies) {
            const positions = [];

            if (side === 'left') {
                positions.push({ x: targetPin.x - strategy.distance - s.w, y: targetPin.y - s.h / 2 + strategy.offsetY });
            } else if (side === 'right') {
                positions.push({ x: targetPin.x + strategy.distance, y: targetPin.y - s.h / 2 + strategy.offsetY });
            } else if (side === 'top') {
                positions.push({ x: targetPin.x - s.w / 2 + strategy.offsetX, y: targetPin.y - strategy.distance - s.h });
            } else {
                positions.push({ x: targetPin.x - s.w / 2 + strategy.offsetX, y: targetPin.y + strategy.distance });
            }

            for (const pos of positions) {
                const x = snap(pos.x);
                const y = snap(pos.y);
                const test = { x: x - AVOID_CLEARANCE, y: y - AVOID_CLEARANCE, w: s.w + 2 * AVOID_CLEARANCE, h: s.h + 2 * AVOID_CLEARANCE };

                if (!this.collidesRect(test) && this.withinCanvas(x, y, s.w, s.h)) {
                    if (isC4) console.log(`%c  - 策略2结果: 成功 (距离: ${strategy.distance})`, 'color: green;');
                    this.setInstPos(inst, x, y);
                    this.addPlaced(inst, 'decoupling');
                    return true;
                }
            }
        }
        if (isC4) console.log(`%c  - 策略2结果: 失败`, 'color: orange;');

        // 最后的备用策略

        const placedOnSide = this.tryPlaceNearCoreSide(core, side, [targetPin], inst, DECAP_MAX_DISTANCE);
        if (isC4) console.log(`%c  - 策略3结果: ${placedOnSide ? '成功' : '失败'}`, placedOnSide ? 'color: green;' : 'color: orange;');

        return placedOnSide;
    }

    findPullsAndFilters(core, excludeRefs = new Set()) {
        const res = [], caps = [];
        const seen = new Set(excludeRefs);
        const gndNames = new Set(this.netList.filter(n => isGndName(n.name)).map(n => n.name));
        const powerNames = new Set(this.netList.filter(n => isPowerName(n.name)).map(n => n.name));
        for (const net of this.netsOfRef(core.ref)) {
            if (isPowerName(net.name) || isGndName(net.name)) continue;
            for (const nd of net.nodes || []) {
                if (nd.ref === core.ref) continue;
                const inst = this.byRef.get(nd.ref);
                if (!inst || seen.has(inst.ref)) continue;
                const t = detectType(inst);
                if (!['Resistor', 'Capacitor'].includes(t)) continue;
                const netsOf = new Set(this.netsOfRef(inst.ref).map(n => n.name));
                const tiedToGnd = [...netsOf].some(nn => gndNames.has(nn));
                const tiedToPwr = [...netsOf].some(nn => powerNames.has(nn));
                if (t === 'Resistor' && (tiedToGnd || tiedToPwr)) {
                    res.push({ inst, anchorNet: net });
                    seen.add(inst.ref);
                } else if (t === 'Capacitor' && tiedToGnd) {
                    caps.push({ inst, anchorNet: net });
                    seen.add(inst.ref);
                }
            }
        }
        return { pulls: res, filters: caps };
    }

    /**
     * @description 识别连接到核心元件的通用IO功能簇。
     * 采用广度优先搜索（BFS）进行局部电路拓扑遍历，以识别完整的、多分支的功能组。
     * @param {object} core - 核心MCU实例。
     * @param {Set<string>} claimedRefs - 一个集合，记录已被其他模块认领的元件，避免重复处理。
     * @returns {Array<object>} 返回识别出的功能簇数组。
     */
    findIOClusters(core, claimedRefs) {
        console.log(`%c[IO簇识别 V4.1] 开始扫描通用IO功能簇 (拓扑路径分析)...`, 'background: #dbeafe; color: #1e3a8a; font-weight: bold;');
        const clusters = [];
        const powerAndGndNames = new Set(
            this.netList.filter(n => isPowerName(n.name) || isGndName(n.name)).map(n => n.name)
        );

        for (const pin of core.pins) {
            if (!pin || !pin.number) continue;
            const pinName = (pin.name || '').toUpperCase();
            if (isPowerName(pinName) || isGndName(pinName) || isResetName(pinName) || pinName.includes('XTAL')) continue;

            const primaryNet = this.netsOfRef(core.ref).find(net => net.nodes.some(n => n.ref === core.ref && n.pin == pin.number));
            if (!primaryNet || powerAndGndNames.has(primaryNet.name)) continue;

            // 步骤 A: BFS 收集所有相关元件
            const group = { components: new Map(), adj: new Map() };
            const q = [primaryNet];
            // [修正] 之前这里错误地只存储了 net.name，现在存储完整的 net 对象
            const visitedNets = new Set([primaryNet]);

            while (q.length > 0) {
                const net = q.shift();
                for (const node of net.nodes) {
                    const inst = this.byRef.get(node.ref);
                    if (!inst || inst === core || claimedRefs.has(inst.ref)) continue;

                    if (!group.components.has(inst.ref)) {
                        group.components.set(inst.ref, inst);
                        group.adj.set(inst.ref, []);
                    }

                    this.netsOfRef(inst.ref).forEach(neighborNet => {
                        if (powerAndGndNames.has(neighborNet.name)) return;
                        // [修正] 检查和添加的都应该是完整的 neighborNet 对象，而不是它的名字
                        if (!visitedNets.has(neighborNet)) {
                            visitedNets.add(neighborNet);
                            q.push(neighborNet);
                        }
                    });
                }
            }

            if (group.components.size === 0) continue;

            // 步骤 B: 在簇内部建立邻接关系图
            // 现在 net 是一个正确的对象，net.nodes 可以安全访问
            for (const net of visitedNets) {
                const connectedRefs = net.nodes.map(n => n.ref).filter(ref => group.components.has(ref));
                for (let i = 0; i < connectedRefs.length; i++) {
                    for (let j = i + 1; j < connectedRefs.length; j++) {
                        group.adj.get(connectedRefs[i]).push(connectedRefs[j]);
                        group.adj.get(connectedRefs[j]).push(connectedRefs[i]);
                    }
                }
            }

            // 步骤 C: DFS 寻找最长路径作为“主干道”
            let longestPath = [];
            const startNodes = primaryNet.nodes.map(n => n.ref).filter(ref => group.components.has(ref));

            const dfs = (nodeRef, path) => {
                path.push(nodeRef);
                if (path.length > longestPath.length) {
                    longestPath = [...path];
                }
                for (const neighbor of group.adj.get(nodeRef) || []) {
                    if (!path.includes(neighbor)) {
                        dfs(neighbor, [...path]);
                    }
                }
            };

            startNodes.forEach(startNode => dfs(startNode, []));

            // 步骤 D: 根据最长路径分配角色
            const mainTrunkRefs = new Set(longestPath);
            const mainTrunk = longestPath.map(ref => group.components.get(ref));
            const sideBranches = [];

            group.components.forEach((inst, ref) => {
                if (!mainTrunkRefs.has(ref)) {
                    sideBranches.push(inst);
                }
            });

            // 步骤 E: 创建结构化簇
            const cluster = {
                mcuPin: pin.number,
                mcuPinPt: pinAbsByNumber(core, pin.number),
                mainTrunk: mainTrunk,
                sideBranches: sideBranches,
                all: [...group.components.values()]
            };

            cluster.all.forEach(c => claimedRefs.add(c.ref));
            console.log(`[IO簇识别 V4.1] 引脚 P${pin.number}: Trunk=[${mainTrunk.map(c => c.ref)}], Branches=[${sideBranches.map(c => c.ref)}]`);
            clusters.push(cluster);
        }

        return clusters;
    }

    /**
     * 分析元件组的电路拓扑，识别串并联关系
     * @param {Array} components - 元件数组
     * @returns {Object} 拓扑分析结果
     */
    analyzeCircuitTopology(components) {
        const topology = {
            serialPairs: [],      // 串联对
            parallelGroups: [],   // 并联组
            serialChains: [],     // 串联链
            mixedGroups: [],      // 混合拓扑组
            standalone: []        // 独立元件
        };

        if (!components || components.length === 0) return topology;

        // 构建元件连接图
        const compRefs = new Set(components.map(c => c.ref));
        const connectionMap = new Map(); // ref -> Set of connected nets

        components.forEach(comp => {
            const nets = this.netsOfRef(comp.ref);
            connectionMap.set(comp.ref, new Set(nets.map(n => n.name)));
        });

        // 检测并联关系：两个元件连接到完全相同的网络集合
        const processedRefs = new Set();

        components.forEach(comp1 => {
            if (processedRefs.has(comp1.ref)) return;

            const nets1 = connectionMap.get(comp1.ref);
            if (nets1.size !== 2) return; // 只处理二端元件

            const parallelGroup = [comp1];

            components.forEach(comp2 => {
                if (comp1.ref === comp2.ref || processedRefs.has(comp2.ref)) return;

                const nets2 = connectionMap.get(comp2.ref);
                if (nets2.size !== 2) return;

                // 检查是否连接到相同的两个网络
                const sameNets = nets1.size === nets2.size &&
                    [...nets1].every(net => nets2.has(net));

                if (sameNets) {
                    parallelGroup.push(comp2);
                    processedRefs.add(comp2.ref);
                }
            });

            if (parallelGroup.length > 1) {
                processedRefs.add(comp1.ref);
                topology.parallelGroups.push({
                    components: parallelGroup,
                    nets: [...nets1],
                    type: this.classifyParallelGroup(parallelGroup)
                });
            }
        });

        // 检测串联链：通过单个网络连接的元件序列
        const visitedInSerial = new Set();

        components.forEach(startComp => {
            if (visitedInSerial.has(startComp.ref) || processedRefs.has(startComp.ref)) return;

            const chain = this.traceSerialChain(startComp, components, visitedInSerial);

            if (chain.length > 1) {
                topology.serialChains.push({
                    components: chain,
                    type: this.classifySerialChain(chain)
                });
                chain.forEach(c => processedRefs.add(c.ref));
            }
        });

        // 检测串联对（更宽松的条件）
        components.forEach(comp1 => {
            if (processedRefs.has(comp1.ref)) return;

            const nets1 = connectionMap.get(comp1.ref);

            components.forEach(comp2 => {
                if (comp1.ref >= comp2.ref || processedRefs.has(comp2.ref)) return;

                const nets2 = connectionMap.get(comp2.ref);

                // 检查是否共享恰好一个网络
                const sharedNets = [...nets1].filter(net => nets2.has(net));

                if (sharedNets.length === 1 &&
                    !this.isPowerOrGndNet(sharedNets[0])) {
                    topology.serialPairs.push({
                        comp1: comp1,
                        comp2: comp2,
                        sharedNet: sharedNets[0]
                    });
                }
            });
        });

        // 收集独立元件
        components.forEach(comp => {
            if (!processedRefs.has(comp.ref)) {
                topology.standalone.push(comp);
            }
        });

        return topology;
    }
    // 新增：总线意识分组（识别共享GND/VCC组，并标记对齐方向）
    identifyBusAwareGroups() {
        const busGroups = [];
        const gndNets = this.netList.filter(n => isGndName(n.name));
        const vccNets = this.netList.filter(n => isPowerName(n.name));
        const powerNets = [...gndNets, ...vccNets];

        powerNets.forEach(net => {
            const refs = [...new Set(net.nodes.map(nd => nd.ref).filter(r => this.byRef.has(r)))];
            if (refs.length >= 2) {  // 至少2个元件共享
                const components = refs.map(r => this.byRef.get(r));
                const group = {
                    type: isGndName(net.name) ? 'GND_BUS' : 'VCC_BUS',
                    components: components,
                    net: net.name,
                    alignment: this.determineGroupAlignment(components)  // 新增：计算对齐方向
                };
                busGroups.push(group);
            }
        });
        return busGroups;
    }

    // 新增：计算组对齐方向（垂直/水平）
    determineGroupAlignment(components) {
        if (components.length < 2) return 'none';
        const xs = components.map(c => c.x || 0);  // 修复: 默认 0 如果未放置
        const ys = components.map(c => c.y || 0);  // 修复: 默认 0 如果未放置
        const spanX = Math.max(...xs) - Math.min(...xs);
        const spanY = Math.max(...ys) - Math.min(...ys);
        return spanY > spanX ? 'vertical' : 'horizontal';
    }

    // 新增：信号流向分类
    classifySignalDirection(inst) {
        const nets = this.netsOfRef(inst.ref);
        const hasInputNet = nets.some(n => n.name.toLowerCase().includes('in') || n.name.toLowerCase().includes('rx'));
        const hasOutputNet = nets.some(n => n.name.toLowerCase().includes('out') || n.name.toLowerCase().includes('tx'));
        if (hasInputNet) return 'input';
        if (hasOutputNet) return 'output';
        return 'io';  // 默认
    }
    /**
     * 识别重复的电路模式（如多个相同的按钮电路）
     * @param {Object} core - 核心MCU
     * @returns {Array} 重复电路组
     */
    // 修复后的 identifyRepeatedCircuits (补全为完整函数)
    identifyRepeatedCircuits(core) {
        console.log(`[重复电路识别] 开始识别重复电路模式...`);
        const repeatedGroups = [];

        // 按引脚收集电路
        const circuitsByPin = new Map();

        for (const pin of core.pins) {
            if (!pin || !pin.number) continue;
            const pinName = (pin.name || '').toUpperCase();

            // 只处理IO引脚
            if (isPowerName(pinName) || isGndName(pinName) || isResetName(pinName)) continue;

            const circuit = this.extractCircuitSignature(core, pin);
            if (circuit) {
                circuitsByPin.set(pin.number, circuit);
            }
        }

        // 按电路签名分组
        const signatureGroups = new Map();

        for (const [pinNum, circuit] of circuitsByPin) {
            const sig = circuit.signature;
            if (!signatureGroups.has(sig)) {
                signatureGroups.set(sig, []);
            }
            signatureGroups.get(sig).push({
                pin: pinNum,
                circuit: circuit
            });
        }

        // 识别重复组（至少2个相同电路才认为是重复模式，修复阈值）
        for (const [sig, circuits] of signatureGroups) {
            if (circuits.length >= 2) {
                console.log(`[重复电路识别] 发现 ${circuits.length} 个相同的 ${sig} 电路`);

                // 按引脚号排序，确保布局顺序
                circuits.sort((a, b) => {
                    // 优先按引脚名称中的数字排序
                    const aName = core.pins.find(p => p.number == a.pin)?.name || '';
                    const bName = core.pins.find(p => p.number == b.pin)?.name || '';
                    const aNum = parseInt(aName.match(/\d+/)?.[0] || a.pin);
                    const bNum = parseInt(bName.match(/\d+/)?.[0] || b.pin);
                    return aNum - bNum;
                });

                repeatedGroups.push({
                    type: sig,
                    circuits: circuits,
                    count: circuits.length
                });
            }
        }

        return repeatedGroups;
    }

    /**
     * 提取电路签名（用于识别相同的电路模式）
     */
    extractCircuitSignature(core, pin) {
        const pinPt = pinAbsByNumber(core, pin.number);
        if (!pinPt) return null;

        const nets = this.netsOfRef(core.ref).filter(net =>
            net.nodes.some(n => n.ref === core.ref && n.pin == pin.number)
        );

        if (nets.length === 0) return null;

        const components = [];

        for (const net of nets) {
            for (const node of net.nodes) {
                if (node.ref === core.ref) continue;
                const inst = this.byRef.get(node.ref);
                if (!inst) continue;

                const type = detectType(inst);
                if (!components.find(c => c.ref === inst.ref)) {
                    components.push({
                        ref: inst.ref,
                        type: type,
                        inst: inst,
                        nets: this.netsOfRef(inst.ref).map(n => n.name)
                    });
                }
            }
        }

        if (components.length === 0) return null;

        // --- 增强的签名逻辑 ---
        let signature = '';

        // 检查按钮电路
        const switchComp = components.find(c =>
            c.type === 'Switch' ||
            c.inst.value?.toLowerCase().includes('sw') ||
            c.inst.ref.toUpperCase().startsWith('S')
        );

        if (switchComp) {
            const hasResistor = components.some(c => c.type === 'Resistor');

            // 检查开关的另一个引脚连接到了哪里
            const netsOfSwitch = new Set(switchComp.nets);
            const pinNetName = nets[0].name; // 与MCU引脚相连的网络
            netsOfSwitch.delete(pinNetName); // 移除与MCU相连的网络，剩下的就是另一端连接的网络

            const otherNetName = netsOfSwitch.values().next().value;

            if (hasResistor) {
                // 传统上拉/下拉
                if (isGndName(otherNetName)) signature = 'BUTTON_PULLUP';
                else if (isPowerName(otherNetName)) signature = 'BUTTON_PULLDOWN';
                else signature = 'BUTTON_WITH_RESISTOR';
            } else {
                // [增强] 处理直连情况
                if (isGndName(otherNetName)) signature = 'BUTTON_DIRECT_GND';
                else if (isPowerName(otherNetName)) signature = 'BUTTON_DIRECT_VCC';
                else signature = 'BUTTON_FLOATING'; // 悬空按钮
            }
        }

        // 可以在此添加其他电路类型的识别逻辑, 例如LED
        const hasLED = components.some(c => c.type === 'LED' || c.inst.value?.toLowerCase().includes('led'));
        const hasResistor = components.some(c => c.type === 'Resistor');
        if (hasLED && hasResistor) {
            signature = 'LED_ARRAY';
        } else if (hasLED) {
            signature = 'LED_DIRECT';
        }


        // 如果没有特定签名，则生成通用签名
        if (!signature && components.length > 0) {
            signature = components.map(c => c.type).sort().join('+');
        }

        // 为调试添加日志，方便追踪
        if (pin.number >= 12 && pin.number <= 19) {

        }

        return signature ? {
            signature: signature,
            components: components,
            pin: pin.number,
            pinPt: pinPt
        } : null;
    }


    /**
     * 统一布局重复电路组
     */
    placeRepeatedCircuitGroup(core, group) {
        console.log(`[重复电路布局] 尝试放置 ${group.count} 个 ${group.type} 电路`);

        // [增强] 检查签名是否包含 "BUTTON"，这是所有按钮类型的共同特征
        if (!group.type.includes('BUTTON')) {
            return false; // 如果不是按钮组，不处理，返回失败
        }

        if (group.circuits.length === 0) return false;

        const pinData = group.circuits.map(c => {
            const pt = pinAbsByNumber(core, c.pin);
            return { pin: c.pin, circuit: c.circuit, pt: pt };
        }).filter(d => d.pt);

        if (pinData.length === 0) return false;

        // ... (这部分计算位置的逻辑保持不变) ...
        const avgX = pinData.reduce((sum, d) => sum + d.pt.x, 0) / pinData.length;
        const avgY = pinData.reduce((sum, d) => sum + d.pt.y, 0) / pinData.length;
        const side = sideOfPinOnInst(core, { x: avgX, y: avgY });

        // 修复: 统一使用 alignment 计算 placeHorizontal，避免重复赋值
        const alignment = group.alignment || this.determineGroupAlignment(group.circuits.map(c => c.circuit.components[0].inst));
        let placeHorizontal = (alignment === 'horizontal');

        // 如果 alignment 未覆盖，使用 side 判断 (原有逻辑)
        if (alignment === 'none') {
            placeHorizontal = (side !== 'left' && side !== 'right');
            if (!placeHorizontal) {
                pinData.sort((a, b) => a.pt.y - b.pt.y);
            } else {
                pinData.sort((a, b) => a.pt.x - b.pt.x);
            }
        } else {
            console.log(`[重复电路布局] 使用对齐方向: ${alignment}`);
        }

        const GROUP_MARGIN = 35;
        const BUTTON_WIDTH_EST = 30;
        const BUTTON_HEIGHT_EST = 30;
        const BUTTON_SPACING = 10;
        const coreSize = effSize(core);

        let currentX, currentY, stepX, stepY;

        if (!placeHorizontal) {
            currentY = pinData[0].pt.y - BUTTON_HEIGHT_EST / 2;
            currentX = (side === 'left')
                ? core.x - GROUP_MARGIN - BUTTON_WIDTH_EST
                : core.x + coreSize.w + GROUP_MARGIN;
            stepX = 0;
            stepY = BUTTON_HEIGHT_EST + BUTTON_SPACING;
        } else {
            currentX = pinData[0].pt.x - BUTTON_WIDTH_EST / 2;
            currentY = (side === 'top')
                ? core.y - GROUP_MARGIN - BUTTON_HEIGHT_EST
                : core.y + coreSize.h + GROUP_MARGIN;
            stepX = BUTTON_WIDTH_EST + BUTTON_SPACING;
            stepY = 0;
        }

        for (let i = 0; i < pinData.length; i++) {
            const { circuit } = pinData[i];
            // 调用子函数进行放置，这个子函数内部会调用 addPlaced 来固定元件
            this.placeButtonCircuit(circuit, currentX, currentY, i, placeHorizontal);
            currentX += stepX;
            currentY += stepY;
        }
        // 新增：为重复组计算路径（用于总线对齐）
        group.path = this.calculateGroupPath(group.circuits.map(c => c.circuit.components[0].inst));
        console.log(`[重复电路布局] 为组 ${group.type} 计算路径: [${group.path.map(p => `(${p.x},${p.y})`).join(' -> ')}]`);
        return true; // 成功执行了放置，返回true
    }
    calculateGroupPath(components) {
        const xs = components.map(c => c.x);
        const ys = components.map(c => c.y);
        const minX = Math.min(...xs), maxX = Math.max(...xs);
        const minY = Math.min(...ys), maxY = Math.max(...ys);
        const alignment = this.determineGroupAlignment(components);
        if (alignment === 'horizontal') {
            const avgY = (minY + maxY) / 2;
            return [{ x: minX, y: avgY }, { x: maxX, y: avgY }];
        } else if (alignment === 'vertical') {
            const avgX = (minX + maxX) / 2;
            return [{ x: avgX, y: minY }, { x: avgX, y: maxY }];
        }
        return [];
    }

    /**
     * 放置单个按钮电路（开关+电阻）
     */
    placeButtonCircuit(circuit, baseX, baseY, index, placeHorizontal = false) {
        const components = circuit.components;

        const switchComp = components.find(c => c.type === 'Switch' || c.inst.value?.toLowerCase().includes('sw'));
        // [已修复] 电阻是可选的
        const resistorComp = components.find(c => c.type === 'Resistor');

        if (!switchComp) return false;

        const sw = switchComp.inst;

        // 放置开关
        sw.rot = placeHorizontal ? 90 : 0;
        const swSize = this.sizeForAngle(sw, sw.rot);
        this.setInstPos(sw, snap(baseX), snap(baseY));
        this.addPlaced(sw, `button_group_${index}`);

        let logMsg = `  -> 按钮电路 ${index + 1}: SW=${sw.ref} at (${sw.x},${sw.y})`;

        // [已修复] 仅当电阻存在时才放置电阻
        if (resistorComp) {
            const res = resistorComp.inst;
            res.rot = placeHorizontal ? 0 : 90;
            const resSize = this.sizeForAngle(res, res.rot);

            let resX, resY;
            if (!placeHorizontal) {
                resX = baseX + swSize.w / 2 - resSize.w / 2;
                resY = baseY - resSize.h - 3;
            } else {
                resX = baseX - resSize.w - 3;
                resY = baseY + swSize.h / 2 - resSize.h / 2;
            }
            this.setInstPos(res, snap(resX), snap(resY));
            this.addPlaced(res, `button_group_${index}`);
            logMsg += `, R=${res.ref} at (${res.x},${res.y})`;
        }

        console.log(logMsg);

        return true;
    }


    /**
     * 放置LED电路
     */
    placeLEDCircuit(circuit, baseX, baseY, index) {
        // LED电路的放置逻辑（类似按钮电路）
        // 实现省略，原理相同
    }
    /**
     * 根据拓扑特征对IO簇进行分类
     * @param {Object} cluster - IO簇
     * @param {Object} topology - 拓扑分析结果
     * @returns {String} 簇类型
     */
    classifyIOClusterByTopology(cluster, topology) {
        const compCount = cluster.all.length;

        // 纯并联电路
        if (topology.parallelGroups.length > 0 &&
            topology.serialChains.length === 0 &&
            topology.serialPairs.length === 0) {
            return 'PARALLEL_CIRCUIT';
        }

        // 纯串联电路
        if (topology.serialChains.length > 0 &&
            topology.parallelGroups.length === 0) {
            return 'SERIES_CIRCUIT';
        }

        // 串并联混合
        if (topology.parallelGroups.length > 0 &&
            (topology.serialChains.length > 0 || topology.serialPairs.length > 0)) {
            return 'MIXED_CIRCUIT';
        }

        // 根据具体电路类型细分
        if (topology.parallelGroups.length > 0) {
            const group = topology.parallelGroups[0];
            if (group.type === 'PROTECTION_CIRCUIT') return 'INPUT_PROTECTION';
            if (group.type === 'LED_CIRCUIT') return 'LED_OUTPUT';
        }

        if (topology.serialChains.length > 0) {
            const chain = topology.serialChains[0];
            if (chain.type === 'RC_FILTER') return 'FILTER_CIRCUIT';
            if (chain.type === 'VOLTAGE_DIVIDER') return 'DIVIDER_CIRCUIT';
        }

        // 默认类型
        if (compCount === 1) return 'SINGLE_COMPONENT';
        if (compCount === 2) return 'COMPONENT_PAIR';

        return 'GENERIC_CLUSTER';
    }

    /**
     * 放置并联电路组
     * @param {Object} core - 核心元件
     * @param {Object} cluster - IO簇
     * @param {Object} topology - 拓扑信息
     */
    placeParallelCircuit(core, cluster, topology) {
        const { mcuPinPt } = cluster;
        if (!mcuPinPt) return;

        console.log(`[并联电路布局] 为 P${cluster.mcuPin} 放置并联电路`);

        const side = sideOfPinOnInst(core, mcuPinPt);

        // 确定布局方向：并联元件垂直排列
        let baseX, baseY;
        const PARALLEL_SPACING = 5; // 并联元件间距
        const PIN_DISTANCE = 15;    // 距离引脚的距离

        // 根据引脚位置确定起始点
        if (side === 'left') {
            baseX = mcuPinPt.x - PIN_DISTANCE - 30;
            baseY = mcuPinPt.y;
        } else if (side === 'right') {
            baseX = mcuPinPt.x + PIN_DISTANCE;
            baseY = mcuPinPt.y;
        } else if (side === 'top') {
            baseX = mcuPinPt.x;
            baseY = mcuPinPt.y - PIN_DISTANCE - 30;
        } else {
            baseX = mcuPinPt.x;
            baseY = mcuPinPt.y + PIN_DISTANCE;
        }

        // 放置每个并联组
        topology.parallelGroups.forEach((group, groupIdx) => {
            let yOffset = 0;

            group.components.forEach((comp, idx) => {
                if (this.fixedRefs.has(comp.ref)) return;

                // 设置元件方向
                if (side === 'left' || side === 'right') {
                    comp.rot = 90; // 垂直放置
                } else {
                    comp.rot = 0;  // 水平放置
                }

                const s = this.sizeForAngle(comp, comp.rot);

                // 计算位置：垂直排列
                let x, y;
                if (side === 'left' || side === 'right') {
                    x = baseX + groupIdx * 40; // 多组并联时水平错开
                    y = baseY + yOffset - s.h / 2;
                    yOffset += s.h + PARALLEL_SPACING;
                } else {
                    x = baseX + yOffset - s.w / 2;
                    y = baseY + groupIdx * 40; // 多组并联时垂直错开
                    yOffset += s.w + PARALLEL_SPACING;
                }

                // 尝试放置
                x = snap(x);
                y = snap(y);

                const test = {
                    x: x - AVOID_CLEARANCE,
                    y: y - AVOID_CLEARANCE,
                    w: s.w + 2 * AVOID_CLEARANCE,
                    h: s.h + 2 * AVOID_CLEARANCE
                };

                if (this.withinCanvas(x, y, s.w, s.h) && !this.collidesRect(test)) {
                    this.setInstPos(comp, x, y);
                    this.addPlaced(comp, 'parallel');
                    console.log(`  -> [并联] ${comp.ref} 放置在 (${x}, ${y})`);
                } else {
                    // 备用策略：尝试其他位置
                    this.tryPlaceNearPosition(comp, mcuPinPt, 50, AVOID_CLEARANCE);
                }
            });
        });

        // 放置独立元件
        topology.standalone.forEach(comp => {
            if (!this.fixedRefs.has(comp.ref)) {
                this.tryPlaceNearPosition(comp, mcuPinPt, 40, AVOID_CLEARANCE);
            }
        });
    }

    /**
     * 放置串联电路链
     * @param {Object} core - 核心元件
     * @param {Object} cluster - IO簇
     * @param {Object} topology - 拓扑信息
     */
    placeSeriesCircuit(core, cluster, topology) {
        const { mcuPinPt } = cluster;
        if (!mcuPinPt) return;

        console.log(`[串联电路布局] 为 P${cluster.mcuPin} 放置串联电路`);

        const side = sideOfPinOnInst(core, mcuPinPt);

        // 确定布局方向：串联元件水平排列
        const SERIES_SPACING = 8;  // 串联元件间距
        const PIN_DISTANCE = 15;   // 距离引脚的距离

        // 放置每个串联链
        topology.serialChains.forEach((chain, chainIdx) => {
            let currentX, currentY;

            // 确定起始位置
            if (side === 'left') {
                currentX = mcuPinPt.x - PIN_DISTANCE;
                currentY = mcuPinPt.y + chainIdx * 30;
            } else if (side === 'right') {
                currentX = mcuPinPt.x + PIN_DISTANCE;
                currentY = mcuPinPt.y + chainIdx * 30;
            } else if (side === 'top') {
                currentX = mcuPinPt.x + chainIdx * 30;
                currentY = mcuPinPt.y - PIN_DISTANCE;
            } else {
                currentX = mcuPinPt.x + chainIdx * 30;
                currentY = mcuPinPt.y + PIN_DISTANCE;
            }

            // 依次放置串联链中的元件
            chain.components.forEach((comp, idx) => {
                if (this.fixedRefs.has(comp.ref)) return;

                // 设置元件方向
                if (side === 'left' || side === 'right') {
                    comp.rot = 0; // 水平放置
                } else {
                    comp.rot = 90; // 垂直放置
                }

                const s = this.sizeForAngle(comp, comp.rot);

                // 计算位置
                let x, y;
                if (side === 'left') {
                    x = currentX - s.w;
                    y = currentY - s.h / 2;
                    currentX -= (s.w + SERIES_SPACING);
                } else if (side === 'right') {
                    x = currentX;
                    y = currentY - s.h / 2;
                    currentX += (s.w + SERIES_SPACING);
                } else if (side === 'top') {
                    x = currentX - s.w / 2;
                    y = currentY - s.h;
                    currentY -= (s.h + SERIES_SPACING);
                } else {
                    x = currentX - s.w / 2;
                    y = currentY;
                    currentY += (s.h + SERIES_SPACING);
                }

                x = snap(x);
                y = snap(y);

                const test = {
                    x: x - AVOID_CLEARANCE,
                    y: y - AVOID_CLEARANCE,
                    w: s.w + 2 * AVOID_CLEARANCE,
                    h: s.h + 2 * AVOID_CLEARANCE
                };

                if (this.withinCanvas(x, y, s.w, s.h) && !this.collidesRect(test)) {
                    this.setInstPos(comp, x, y);
                    this.addPlaced(comp, 'series');
                    console.log(`  -> [串联] ${comp.ref} 放置在 (${x}, ${y})`);
                } else {
                    this.tryPlaceNearPosition(comp, { x: currentX, y: currentY }, 30, AVOID_CLEARANCE);
                }
            });
        });

        // 放置串联对
        topology.serialPairs.forEach(pair => {
            if (!this.fixedRefs.has(pair.comp1.ref)) {
                this.tryPlaceNearPosition(pair.comp1, mcuPinPt, 40, AVOID_CLEARANCE);
            }
            if (!this.fixedRefs.has(pair.comp2.ref)) {
                const comp1Pos = {
                    x: pair.comp1.x + effSize(pair.comp1).w / 2,
                    y: pair.comp1.y + effSize(pair.comp1).h / 2
                };
                this.tryPlaceNearPosition(pair.comp2, comp1Pos, 20, AVOID_CLEARANCE);
            }
        });
    }

    /**
     * 放置混合电路
     * @param {Object} core - 核心元件
     * @param {Object} cluster - IO簇
     * @param {Object} topology - 拓扑信息
     */
    placeMixedCircuit(core, cluster, topology) {
        const { mcuPinPt } = cluster;
        if (!mcuPinPt) return;

        console.log(`[混合电路布局] 为 P${cluster.mcuPin} 放置混合电路`);

        // 优先放置并联组（通常是主要功能）
        if (topology.parallelGroups.length > 0) {
            this.placeParallelCircuit(core,
                { ...cluster, all: topology.parallelGroups.flatMap(g => g.components) },
                { parallelGroups: topology.parallelGroups, standalone: [] }
            );
        }

        // 然后放置串联链
        if (topology.serialChains.length > 0) {
            this.placeSeriesCircuit(core,
                { ...cluster, all: topology.serialChains.flatMap(c => c.components) },
                { serialChains: topology.serialChains, serialPairs: [] }
            );
        }

        // 最后放置其他元件
        topology.standalone.forEach(comp => {
            if (!this.fixedRefs.has(comp.ref)) {
                this.tryPlaceNearPosition(comp, mcuPinPt, 50, AVOID_CLEARANCE);
            }
        });
    }

    /**
     * 追踪串联链
     */
    traceSerialChain(startComp, allComponents, visited) {
        const chain = [startComp];
        visited.add(startComp.ref);

        let currentComp = startComp;
        let continueTrace = true;

        while (continueTrace) {
            continueTrace = false;
            const currentNets = this.netsOfRef(currentComp.ref);

            // 寻找下一个串联元件
            for (const net of currentNets) {
                if (this.isPowerOrGndNet(net.name)) continue;

                const connectedComps = net.nodes
                    .map(n => n.ref)
                    .filter(ref => ref !== currentComp.ref && !visited.has(ref))
                    .map(ref => allComponents.find(c => c.ref === ref))
                    .filter(Boolean);

                if (connectedComps.length === 1) {
                    const nextComp = connectedComps[0];
                    const nextNets = this.netsOfRef(nextComp.ref);

                    // 检查是否是二端元件且形成串联
                    if (nextNets.length === 2) {
                        chain.push(nextComp);
                        visited.add(nextComp.ref);
                        currentComp = nextComp;
                        continueTrace = true;
                        break;
                    }
                }
            }
        }

        return chain;
    }

    /**
     * 分类并联组
     */
    classifyParallelGroup(components) {
        const types = components.map(c => detectType(c));

        if (types.every(t => t === 'Resistor')) return 'RESISTOR_PARALLEL';
        if (types.every(t => t === 'Capacitor')) return 'CAPACITOR_PARALLEL';
        if (types.includes('Resistor') && types.includes('Diode')) return 'PROTECTION_CIRCUIT';
        if (types.includes('Resistor') && types.includes('LED')) return 'LED_CIRCUIT';

        return 'MIXED_PARALLEL';
    }

    /**
     * 分类串联链
     */
    classifySerialChain(components) {
        const types = components.map(c => detectType(c));

        if (types.includes('Resistor') && types.includes('Capacitor')) return 'RC_FILTER';
        if (types.includes('Resistor') && types.includes('LED')) return 'LED_DRIVER';
        if (types.every(t => t === 'Resistor')) return 'VOLTAGE_DIVIDER';

        return 'MIXED_SERIAL';
    }

    /**
     * 检查是否是电源或地网络
     */
    isPowerOrGndNet(netName) {
        return isPowerName(netName) || isGndName(netName);
    }

    /**
     * @description 总控函数，用于调用IO簇的识别和放置。
     * @param {object} core - 核心MCU实例
     * @returns {Set<string>} 返回所有被IO簇逻辑处理过的元件引用集合。
     */
    placeAllIOClusters(core) {
        const claimedByIO = new Set();
        const clusters = this.findIOClusters(core, claimedByIO);

        for (const cluster of clusters) {
            const alreadyPlaced = cluster.components.some(c => this.fixedRefs.has(c.ref));
            if (alreadyPlaced) {
                console.warn(`[IO簇放置] 跳过引脚 P${cluster.mcuPin} 的簇，因为其部分元件已被放置。`);
                continue;
            }

            // 注意：placeIOCluster 方法我们将在下一步实现。
            // 现在只是一个占位调用。
            this.placeIOCluster(core, cluster);
        }

        return claimedByIO;
    }

    /**
     * 智能放置IO簇 - 根据拓扑特征选择布局策略
     * @param {Object} core - 核心元件
     * @param {Object} cluster - IO簇
     */
    placeIOCluster(core, cluster) {
        const { mcuPinPt, all } = cluster;
        console.log(`[IO簇放置-智能] 处理 P${cluster.mcuPin} 的功能簇`);

        if (!mcuPinPt || !all || all.length === 0) return;

        // 步骤1：分析电路拓扑
        const topology = this.analyzeCircuitTopology(all);

        // 步骤2：根据拓扑特征分类
        const clusterType = this.classifyIOClusterByTopology(cluster, topology);

        console.log(`  簇类型: ${clusterType}`);
        console.log(`  并联组: ${topology.parallelGroups.length}, 串联链: ${topology.serialChains.length}`);

        // 步骤3：根据类型选择布局策略
        switch (clusterType) {
            case 'PARALLEL_CIRCUIT':
            case 'INPUT_PROTECTION':
            case 'LED_OUTPUT':
                this.placeParallelCircuit(core, cluster, topology);
                break;

            case 'SERIES_CIRCUIT':
            case 'FILTER_CIRCUIT':
            case 'DIVIDER_CIRCUIT':
                this.placeSeriesCircuit(core, cluster, topology);
                break;

            case 'MIXED_CIRCUIT':
                this.placeMixedCircuit(core, cluster, topology);
                break;

            case 'SINGLE_COMPONENT':
                if (all[0] && !this.fixedRefs.has(all[0].ref)) {
                    this.tryPlaceNearPosition(all[0], mcuPinPt, 40, AVOID_CLEARANCE);
                }
                break;

            default:
                // 使用原有的默认布局策略
                this.placeIOClusterDefault(core, cluster);
                break;
        }
    }

    /**
     * 默认IO簇布局（保留原有逻辑作为备用）
     */
    placeIOClusterDefault(core, cluster) {
        const { mcuPinPt, mainTrunk, sideBranches } = cluster;
        if (!mcuPinPt) return;

        const side = sideOfPinOnInst(core, mcuPinPt);
        const AXIS_STEP = 35;
        let pathVector;

        if (side === 'left') pathVector = { x: -AXIS_STEP, y: 0 };
        else if (side === 'right') pathVector = { x: AXIS_STEP, y: 0 };
        else if (side === 'top') pathVector = { x: 0, y: -AXIS_STEP };
        else pathVector = { x: 0, y: AXIS_STEP };

        let lastAnchor = mcuPinPt;
        const trunkPlacements = new Map();

        // 放置主干道元件
        for (const inst of (mainTrunk || [])) {
            if (this.fixedRefs.has(inst.ref)) continue;
            const targetPos = {
                x: lastAnchor.x + pathVector.x,
                y: lastAnchor.y + pathVector.y
            };
            if (this.tryPlaceNearPosition(inst, targetPos, 25, 2)) {
                const s = effSize(inst);
                lastAnchor = { x: inst.x + s.w / 2, y: inst.y + s.h / 2 };
                trunkPlacements.set(inst.ref, lastAnchor);
            }
        }

        // 放置支路元件
        for (const inst of (sideBranches || [])) {
            if (this.fixedRefs.has(inst.ref)) continue;
            let parentAnchor = mcuPinPt;

            for (const net of this.netsOfRef(inst.ref)) {
                for (const node of net.nodes) {
                    if (trunkPlacements.has(node.ref)) {
                        parentAnchor = trunkPlacements.get(node.ref);
                        break;
                    }
                }
            }

            this.tryPlaceNearPosition(inst, parentAnchor, 40, 2);
        }
    }

    findSeriesPassives(core) {
        const passives = [];
        const seen = new Set();
        const passiveTypes = ['Resistor', 'Capacitor', 'Inductor', 'Diode'];
        for (const net of this.netList) {
            if (isPowerName(net.name) || isGndName(net.name)) continue;
            const coreNode = net.nodes.find(n => n.ref === core.ref);
            if (!coreNode) continue;

            for (const node of net.nodes) {
                const inst = this.byRef.get(node.ref);
                if (!inst || seen.has(inst.ref) || !passiveTypes.includes(detectType(inst))) continue;

                const passiveNets = this.netsOfRef(inst.ref);
                if (passiveNets.length !== 2) continue;

                const otherNet = passiveNets.find(n => n.name !== net.name);
                if (!otherNet || otherNet.nodes.length < 2) continue;

                const otherNode = otherNet.nodes.find(n => n.ref !== inst.ref);
                if (!otherNode) continue;

                passives.push({ inst, coreNode, otherNode, net, otherNet });
                seen.add(inst.ref);
            }
        }
        return passives;
    }

    placeSeriesPassive(core, pInfo) {
        const p1 = pinAbsByNumber(core, pInfo.coreNode.pin);
        const otherInst = this.byRef.get(pInfo.otherNode.ref);
        if (!p1 || !otherInst) return false;
        const p2 = pinAbsByNumber(otherInst, pInfo.otherNode.pin);
        if (!p2) return false;

        const inst = pInfo.inst;
        inst.rot = (Math.abs(p2.x - p1.x) > Math.abs(p2.y - p1.y)) ? 0 : 90;
        const s = effSize(inst);

        for (let i = 0; i < 20; i++) {
            const ratio = 0.4 + (i * 0.02);
            const midX = p1.x + (p2.x - p1.x) * ratio;
            const midY = p1.y + (p2.y - p1.y) * ratio;
            const x = snap(midX - s.w / 2);
            const y = snap(midY - s.h / 2);
            const testRect = {
                x: x - AVOID_CLEARANCE,
                y: y - AVOID_CLEARANCE,
                w: s.w + 2 * AVOID_CLEARANCE,
                h: s.h + 2 * AVOID_CLEARANCE
            };
            if (!this.collidesRect(testRect) && this.withinCanvas(x, y, s.w, s.h)) {
                this.setInstPos(inst, x, y);
                this.addPlaced(inst);
                return true;
            }
        }
        return false;
    }

    placeCriticalPeripherals(core) {
        console.group(`处理核心 [${core.ref}] 的高优先级外围电路`);

        let criticalCount = 0;

        // 步骤1：识别并放置MCU自身的去耦电容
        console.log(`[关键外围电路] 步骤1: 放置MCU去耦电容`);
        const decaps = this.layoutPlan.decouplingCapsByCore.get(core.ref) || [];

        for (const decapInfo of decaps) {
            if (this.fixedRefs.has(decapInfo.inst.ref)) continue;

            // 调用您已有的、功能强大的 placeDecouplingCapEnhanced
            const placed = this.placeDecouplingCapEnhanced(core, decapInfo);

            if (placed) {
                criticalCount++;
                console.log(`  -> ${decapInfo.inst.ref} 放置成功`);
            } else {
                console.warn(`  -> ${decapInfo.inst.ref} 放置失败`);
            }
        }

        // 步骤2：放置晶振电路
        console.log(`[关键外围电路] 步骤2: 放置晶振电路`);
        const xtalGroups = this.findCrystalGroups(core);
        xtalGroups.forEach((g, idx) => {
            if (!this.fixedRefs.has(g.crystal.ref)) {
                if (this.placeCrystalGroup(core, g)) { // 调用您已有的 placeCrystalGroup
                    criticalCount += (1 + g.caps.length);
                    console.log(`  -> 晶振组 ${g.crystal.ref} 放置成功`);
                }
            }
        });

        // 步骤3：放置复位电路
        console.log(`[关键外围电路] 步骤3: 放置复位电路`);
        const resetCircuits = this.findResetCircuit(core);
        resetCircuits.forEach((rc, idx) => {
            // 调用您已有的 placeResetCircuit
            if (this.placeResetCircuit(core, rc)) {
                if (rc.resistor) criticalCount++;
                if (rc.capacitor) criticalCount++;
                console.log(`  -> 复位电路 (R=${rc.resistor?.ref}, C=${rc.capacitor?.ref}) 放置成功`);
            }
        });

        console.log(`%c[关键外围电路] 完成！共放置 ${criticalCount} 个高优先级元件`, 'color: green; font-weight: bold;');


        // 这个返回值在新架构中意义不大，但保留亦无妨
        return criticalCount;
    }

    place() {
        console.log(`%c========== 开始自动布局 ==========`, 'background: #1e293b; color: white; font-weight: bold; font-size: 16px;');

        const core = this.chooseCore();
        if (!core) {
            console.warn(`未找到核心元件，无法进行布局`);
            return;
        }

        console.log(`核心元件: ${core.ref}`);

        // 步骤1：放置核心元件
        console.log(`\n[布局步骤1] 放置核心元件`);
        this.centerCore(core);
        console.log(`核心元件 ${core.ref} 已居中放置`);

        // 步骤2：放置关键外围电路（包括去耦电容）
        console.log(`\n[布局步骤2] 放置关键外围电路`);
        const criticalCount = this.placeCriticalPeripherals(core);
        console.log(`关键外围电路放置完成，共 ${criticalCount} 个`);

        // 步骤3：放置连接器
        console.log(`\n[布局步骤3] 放置连接器`);
        this.placeConnectors();
        const connectorCount = this.instances.filter(i => isConnector(i) && this.fixedRefs.has(i.ref)).length;
        console.log(`连接器放置完成，共 ${connectorCount} 个`);

        // 步骤4：放置功能簇
        console.log(`\n[布局步骤4] 放置功能簇`);
        this.placeFunctionalClusters(core);
        const remainingCount = this.instances.filter(i => !this.fixedRefs.has(i.ref)).length;
        console.log(`功能簇放置完成，剩余未放置: ${remainingCount} 个`);

        // 步骤5：验证布局质量
        console.log(`\n[布局步骤5] 验证布局质量`);
        const validation = this.validatePlacement();

        // 特别检查C4
        const c4 = this.byRef.get('C4');
        if (c4) {

            console.log(`C4最终位置: (${c4.x}, ${c4.y})`);
            console.log(`C4旋转角度: ${c4.rot || 0}°`);

            // 计算C4到U1引脚40的距离
            const u1 = this.byRef.get('U1');
            if (u1) {
                const pin40 = pinAbsByNumber(u1, 40);
                if (pin40) {
                    const dist = Math.hypot(c4.x + effSize(c4).w / 2 - pin40.x,
                        c4.y + effSize(c4).h / 2 - pin40.y);
                    console.log(`C4到U1引脚40的距离: ${dist.toFixed(1)}px`);

                    if (dist > 50) {
                        console.warn(`%c警告: C4距离U1引脚40过远 (${dist.toFixed(1)}px > 50px)`, 'color: orange; font-weight: bold;');
                    } else {
                        console.log(`%c✓ C4位置合适`, 'color: green; font-weight: bold;');
                    }
                }
            }
        }

        console.log(`%c========== 布局完成 ==========`, 'background: #1e293b; color: white; font-weight: bold; font-size: 16px;');
    }

    // 5. 修改碰撞检测方法，支持组内元件的特殊处理
    collidesRect(test, group = null) {
        return this.placedRects.some(r => {
            // 对于同组元件（如去耦电容组），使用更宽松的间距
            if (group && r.group === group) {
                // 同组元件允许更紧密放置
                const tightTest = {
                    x: test.x + 1,
                    y: test.y + 1,
                    w: test.w - 2,
                    h: test.h - 2
                };
                const collides = rectsOverlap(r, tightTest);
                if (collides && test.debug) {
                    console.log(`  同组碰撞: 与 group=${r.group} 的矩形碰撞`);
                }
                return collides;
            }

            // 不同组使用正常间距
            const collides = rectsOverlap(r, test);
            if (collides && test.debug) {
                console.log(`  普通碰撞: 与矩形 (${r.x}, ${r.y}, ${r.w}x${r.h}) 碰撞`);
            }
            return collides;
        });
    }

    classifyConnector(inst) {
        const ref = (inst.ref || '').toUpperCase();
        const val = (inst.value || '').toLowerCase();
        const key = (inst.symbol.key || '').toLowerCase();
        const pinCount = inst.pins?.length || 0;

        if (ref === 'POWER-2P' || ref === 'POWER' || ref.startsWith('PWR') ||
            ref.startsWith('J') && val.includes('power') ||
            val.includes('power') || val.includes('vin') ||
            val.includes('dc') || val.includes('pwr') || val.includes('supply') ||
            val.includes('12v') || val.includes('5v') || val.includes('vcc') ||
            (pinCount === 2 && (val.includes('2p') || ref.includes('2P') || ref === 'J1'))) {
            return 'POWER';
        }

        if (ref.includes('MOTOR') || ref === 'STEP-MOTOR' ||
            val.includes('motor') || val.includes('stepper') || val.includes('step') ||
            (pinCount === 5 && (ref.includes('STEP') || val.includes('step')))) {
            return 'OUTPUT';
        }

        if (val.includes('led') || val.includes('display') ||
            val.includes('lcd') || val.includes('oled') ||
            val.includes('out') || ref.startsWith('D')) {
            return 'OUTPUT';
        }

        if (val.includes('sw') || val.includes('switch') ||
            val.includes('button') || val.includes('sensor') ||
            val.includes('input') || val.includes('in')) {
            return 'INPUT';
        }

        if (val.includes('uart') || val.includes('serial') ||
            val.includes('rs232') || val.includes('rs485') ||
            val.includes('i2c') || val.includes('spi') ||
            val.includes('can') || val.includes('comm')) {
            return 'COMM';
        }

        if (pinCount === 2 || pinCount === 3) return 'INPUT';
        if (pinCount >= 5 && pinCount <= 6) return 'OUTPUT';
        if (pinCount >= 8) return 'IO';

        return 'IO';
    }

    findSpotOnEdge(inst, edgeType) {
        const s = effSize(inst);
        let x, y;
        const yStep = s.h + CLUSTER_LOCAL_SPACING;
        const xStep = s.w + CLUSTER_LOCAL_SPACING;

        if (edgeType === 'left') {
            x = EDGE_MARGIN;
            for (y = EDGE_MARGIN; y < this.H - s.h - EDGE_MARGIN; y += yStep) {
                const testRect = { x: x - AVOID_CLEARANCE, y: y - AVOID_CLEARANCE, w: s.w + 2 * AVOID_CLEARANCE, h: s.h + 2 * AVOID_CLEARANCE };
                if (!this.collidesRect(testRect)) return { x, y };
            }
        } else if (edgeType === 'right') {
            x = this.W - s.w - EDGE_MARGIN;
            for (y = EDGE_MARGIN; y < this.H - s.h - EDGE_MARGIN; y += yStep) {
                const testRect = { x: x - AVOID_CLEARANCE, y: y - AVOID_CLEARANCE, w: s.w + 2 * AVOID_CLEARANCE, h: s.h + 2 * AVOID_CLEARANCE };
                if (!this.collidesRect(testRect)) return { x, y };
            }
        } else if (edgeType === 'bottom') {
            y = this.H - s.h - EDGE_MARGIN;
            for (x = EDGE_MARGIN; x < this.W - s.w - EDGE_MARGIN; x += xStep) {
                const testRect = { x: x - AVOID_CLEARANCE, y: y - AVOID_CLEARANCE, w: s.w + 2 * AVOID_CLEARANCE, h: s.h + 2 * AVOID_CLEARANCE };
                if (!this.collidesRect(testRect)) return { x, y };
            }
        } else if (edgeType === 'top') {
            y = EDGE_MARGIN;
            for (x = EDGE_MARGIN; x < this.W - s.w - EDGE_MARGIN; x += xStep) {
                const testRect = { x: x - AVOID_CLEARANCE, y: y - AVOID_CLEARANCE, w: s.w + 2 * AVOID_CLEARANCE, h: s.h + 2 * AVOID_CLEARANCE };
                if (!this.collidesRect(testRect)) return { x, y };
            }
        }
        return null;
    }

    findSpotOnEdgeWithSpacing(inst, edgeType, usedPositions) {
        const s = effSize(inst);
        const MIN_SPACING = CLUSTER_LOCAL_SPACING;
        let x, y;

        if (edgeType === 'left' || edgeType === 'right') {
            x = edgeType === 'left' ? EDGE_MARGIN : this.W - s.w - EDGE_MARGIN;
            const sortedY = usedPositions.map(p => ({ start: p.y, end: p.y + p.h })).sort((a, b) => a.start - b.start);
            let lastEnd = EDGE_MARGIN;
            for (const pos of sortedY) {
                if (pos.start - lastEnd >= s.h + MIN_SPACING) {
                    y = lastEnd + MIN_SPACING / 2;
                    const testRect = { x: x - AVOID_CLEARANCE, y: y - AVOID_CLEARANCE, w: s.w + 2 * AVOID_CLEARANCE, h: s.h + 2 * AVOID_CLEARANCE };
                    if (!this.collidesRect(testRect) && this.withinCanvas(x, y, s.w, s.h)) return { x, y };
                }
                lastEnd = pos.end;
            }
            y = lastEnd + MIN_SPACING;
            if (y + s.h <= this.H - EDGE_MARGIN) {
                const testRect = { x: x - AVOID_CLEARANCE, y: y - AVOID_CLEARANCE, w: s.w + 2 * AVOID_CLEARANCE, h: s.h + 2 * AVOID_CLEARANCE };
                if (!this.collidesRect(testRect)) return { x, y };
            }
        } else {
            y = edgeType === 'top' ? EDGE_MARGIN : this.H - s.h - EDGE_MARGIN;
            const sortedX = usedPositions.map(p => ({ start: p.x, end: p.x + p.w })).sort((a, b) => a.start - b.start);
            let lastEnd = EDGE_MARGIN;
            for (const pos of sortedX) {
                if (pos.start - lastEnd >= s.w + MIN_SPACING) {
                    x = lastEnd + MIN_SPACING / 2;
                    const testRect = { x: x - AVOID_CLEARANCE, y: y - AVOID_CLEARANCE, w: s.w + 2 * AVOID_CLEARANCE, h: s.h + 2 * AVOID_CLEARANCE };
                    if (!this.collidesRect(testRect) && this.withinCanvas(x, y, s.w, s.h)) return { x, y };
                }
                lastEnd = pos.end;
            }
            x = lastEnd + MIN_SPACING;
            if (x + s.w <= this.W - EDGE_MARGIN) {
                const testRect = { x: x - AVOID_CLEARANCE, y: y - AVOID_CLEARANCE, w: s.w + 2 * AVOID_CLEARANCE, h: s.h + 2 * AVOID_CLEARANCE };
                if (!this.collidesRect(testRect)) return { x, y };
            }
        }
        return this.findSpotOnEdge(inst, edgeType);
    }

    placeConnectors() {
        const connectors = this.instances.filter(i => isConnector(i) && !this.fixedRefs.has(i.ref));
        const connByType = { POWER: [], OUTPUT: [], INPUT: [], COMM: [], IO: [] };

        connectors.forEach(c => {
            const type = this.classifyConnector(c);
            connByType[type].push(c);
        });

        Object.keys(connByType).forEach(type => {
            connByType[type].sort((a, b) => a.ref.localeCompare(b.ref));
        });

        const edgePlacements = [
            { type: 'POWER', edge: 'left' },
            { type: 'INPUT', edge: 'left' },
            { type: 'OUTPUT', edge: 'right' },
            { type: 'COMM', edge: 'bottom' },
            { type: 'IO', edge: 'bottom' }
        ];

        const edgeUsage = { left: [], right: [], top: [], bottom: [] };

        edgePlacements.forEach(({ type, edge }) => {
            connByType[type].forEach(inst => {
                let pos = this.findSpotOnEdgeWithSpacing(inst, edge, edgeUsage[edge]);
                if (pos) {
                    this.setInstPos(inst, pos.x, pos.y);
                    this.addPlaced(inst);
                    edgeUsage[edge].push({ x: pos.x, y: pos.y, w: effSize(inst).w, h: effSize(inst).h });
                    return;
                }

                const alternatives = edge === 'left' ? ['top', 'bottom'] :
                    edge === 'right' ? ['bottom', 'top'] :
                        edge === 'top' ? ['left', 'right'] :
                            ['right', 'left'];

                for (const altEdge of alternatives) {
                    pos = this.findSpotOnEdgeWithSpacing(inst, altEdge, edgeUsage[altEdge]);
                    if (pos) {
                        this.setInstPos(inst, pos.x, pos.y);
                        this.addPlaced(inst);
                        edgeUsage[altEdge].push({ x: pos.x, y: pos.y, w: effSize(inst).w, h: effSize(inst).h });
                        break;
                    }
                }
            });
        });
    }


    placeFunctionalClusters(core) {
        const remaining = this.instances.filter(i => !this.fixedRefs.has(i.ref));
        if (!remaining.length) return;

        const remSet = new Set(remaining.map(i => i.ref));
        const adjRem = new Map();
        remSet.forEach(r => adjRem.set(r, new Set()));

        for (const net of this.netList) {
            const refs = [...new Set(net.nodes.map(nd => nd.ref))].filter(r => remSet.has(r));
            for (let i = 0; i < refs.length; i++) {
                for (let j = i + 1; j < refs.length; j++) {
                    adjRem.get(refs[i]).add(refs[j]);
                    adjRem.get(refs[j]).add(refs[i]);
                }
            }
        }

        const clusters = [];
        const visited = new Set();
        for (const r of remSet) {
            if (visited.has(r)) continue;
            const q = [r];
            visited.add(r);
            const comp = [r];
            while (q.length) {
                const u = q.shift();
                for (const v of (adjRem.get(u) || [])) {
                    if (!visited.has(v)) {
                        visited.add(v);
                        q.push(v);
                        comp.push(v);
                    }
                }
            }
            clusters.push(comp.map(ref => this.byRef.get(ref)).filter(Boolean));
        }

        const clustersWithAttraction = clusters.map(cluster => {
            let totalWeight = 0;
            let avgX = 0, avgY = 0;
            const clusterRefs = new Set(cluster.map(i => i.ref));

            for (const net of this.netList) {
                const hasInternal = net.nodes.some(n => clusterRefs.has(n.ref));
                const externalNodes = net.nodes.filter(n => !clusterRefs.has(n.ref) && this.fixedRefs.has(n.ref));
                if (hasInternal && externalNodes.length > 0) {
                    for (const extNode of externalNodes) {
                        const inst = this.byRef.get(extNode.ref);
                        if (inst) {
                            const s = effSize(inst);
                            avgX += inst.x + s.w / 2;
                            avgY += inst.y + s.h / 2;
                            totalWeight++;
                        }
                    }
                }
            }

            const attractionPoint = totalWeight > 0 ?
                { x: avgX / totalWeight, y: avgY / totalWeight } :
                { x: this.W / 2, y: this.H / 2 };

            const coreLinks = cluster.reduce((count, inst) => count + (this.netsOfRef(inst.ref).filter(n => n.nodes.some(nd => nd.ref === core.ref)).length), 0);

            return { cluster, attractionPoint, coreLinks };
        });

        clustersWithAttraction.sort((a, b) => b.coreLinks - a.coreLinks);

        const seedOf = (arr) => {
            const scored = arr.map(i => {
                const tp = detectType(i);
                const pri = (tp === 'IC') ? 3 : (isConnector(i)) ? 2 : (tp === 'Misc') ? 1 : 0;
                return { i, pri, deg: this.degree(i.ref) };
            }).sort((a, b) => (b.pri - a.pri) || (b.deg - a.deg));
            return scored[0]?.i || arr[0];
        };

        for (const { cluster, attractionPoint } of clustersWithAttraction) {
            const seed = seedOf(cluster);
            if (!seed || this.fixedRefs.has(seed.ref)) continue;

            let placed = false;
            let ringR = CLUSTER_RING_BASE;

            // [优化] 创建一个优先搜索角度的列表
            const prioritizedAngles = [];
            // 1. 优先搜索左右两侧 (180度 +/- 30度, 0度 +/- 30度)
            for (let i = 0; i <= 30; i += 10) {
                prioritizedAngles.push(180 + i);
                prioritizedAngles.push(180 - i);
                prioritizedAngles.push(0 + i);
                prioritizedAngles.push(0 - i);
            }
            // 2. 其次搜索上下两侧 (90度 +/- 30度, 270度 +/- 30度)
            for (let i = 0; i <= 30; i += 10) {
                prioritizedAngles.push(90 + i);
                prioritizedAngles.push(90 - i);
                prioritizedAngles.push(270 + i);
                prioritizedAngles.push(270 - i);
            }
            // 3. 最后搜索剩余的角度，确保全覆盖
            for (let angle = 0; angle < 360; angle += 20) {
                if (!prioritizedAngles.includes(angle)) {
                    prioritizedAngles.push(angle);
                }
            }
            const uniqueAngles = [...new Set(prioritizedAngles)]; // 去重

            // [优化] 使用新的搜索策略
            for (let rStep = 0; rStep < 15 && !placed; rStep++) {
                const currentRadius = ringR + rStep * CLUSTER_RING_STEP;
                for (const angleDeg of uniqueAngles) {
                    const angleRad = angleDeg * Math.PI / 180;
                    const x = snap(attractionPoint.x + currentRadius * Math.cos(angleRad) - effSize(seed).w / 2);
                    const y = snap(attractionPoint.y + currentRadius * Math.sin(angleRad) - effSize(seed).h / 2);
                    const s = effSize(seed);
                    const test = { x: x - AVOID_CLEARANCE, y: y - AVOID_CLEARANCE, w: s.w + 2 * AVOID_CLEARANCE, h: s.h + 2 * AVOID_CLEARANCE };

                    if (this.withinCanvas(x, y, s.w, s.h) && !this.collidesRect(test)) {
                        this.setInstPos(seed, x, y);
                        this.addPlaced(seed);
                        placed = true;
                        break; // 找到位置，跳出角度循环
                    }
                }
            }

            if (!placed) {
                this.setInstPos(seed, snap(Math.random() * (this.W - 100)), snap(Math.random() * (this.H - 100)));
                this.addPlaced(seed);
            }

            // 放置簇中的其他元件 (这部分逻辑保持不变)
            const others = cluster.filter(i => i.ref !== seed.ref);
            const seedCenter = { x: seed.x + effSize(seed).w / 2, y: seed.y + effSize(seed).h / 2 };
            let localRingR = Math.max(effSize(seed).w, effSize(seed).h) / 2 + CLUSTER_LOCAL_SPACING;
            let k = 0;
            for (const it of others) {
                if (this.fixedRefs.has(it.ref)) continue;
                let ok = false, localTries = 0;
                while (!ok && localTries < 120) {
                    const ang = 2 * Math.PI * ((k % 8) / 8) + Math.floor(k / 8) * 0.4;
                    const ax = seedCenter.x + localRingR * Math.cos(ang);
                    const ay = seedCenter.y + localRingR * Math.sin(ang);
                    it.rot = 0;
                    const s = this.sizeForAngle(it, it.rot);
                    const x = snap(ax - s.w / 2), y = snap(ay - s.h / 2);
                    const test = { x: x - AVOID_CLEARANCE, y: y - AVOID_CLEARANCE, w: s.w + 2 * AVOID_CLEARANCE, h: s.h + 2 * AVOID_CLEARANCE };
                    if (this.withinCanvas(x, y, s.w, s.h) && !this.collidesRect(test)) {
                        this.setInstPos(it, x, y);
                        this.addPlaced(it);
                        ok = true;
                    } else {
                        k++;
                        if (k % 8 === 0) localRingR += CLUSTER_LOCAL_SPACING;
                        localTries++;
                    }
                }
            }
        }
    }

    validatePlacement() {
        const core = this.chooseCore();
        if (!core) return;

        let warnings = [];
        let criticals = [];

        const crystals = this.instances.filter(i => detectType(i) === 'Crystal');
        crystals.forEach(xtal => {
            const coreSize = effSize(core);
            const xtalSize = effSize(xtal);
            const coreCenterX = core.x + coreSize.w / 2;
            const coreCenterY = core.y + coreSize.h / 2;
            const xtalCenterX = xtal.x + xtalSize.w / 2;
            const xtalCenterY = xtal.y + xtalSize.h / 2;
            const dist = Math.hypot(xtalCenterX - coreCenterX, xtalCenterY - coreCenterY);

            if (dist > CRYSTAL_MAX_DISTANCE) {
                const msg = `晶振 ${xtal.ref} 距离MCU ${Math.round(dist)}px (应 <${CRYSTAL_MAX_DISTANCE}px)`;
                criticals.push(msg);
            }
        });
        // 新增：检查组对齐度
        this.layoutPlan.repeatedGroups.forEach(group => {
            const validYs = group.circuits
                .map(c => c.circuit?.components?.[0]?.inst?.y)
                .filter(y => typeof y === 'number' && !isNaN(y));  // 过滤有效 y 值
            if (validYs.length < 2) return;  // 跳过无效组

            const mean = validYs.reduce((a, b) => a + b, 0) / validYs.length;
            const variance = validYs.reduce((sum, y) => sum + Math.pow(y - mean, 2), 0) / validYs.length;
            if (variance > 10) warnings.push(`组 ${group.type} 对齐度差 (方差: ${variance.toFixed(2)})`);
        });;
        const allICs = this.instances.filter(i => ['MCU', 'IC'].includes(detectType(i)));
        allICs.forEach(ic => {
            const powerNets = this.netsOfRef(ic.ref).filter(n => isPowerName(n.name));
            if (powerNets.length > 0) {
                const decaps = this.findDecouplingCaps(ic);
                if (decaps.length === 0) {
                    const msg = `IC ${ic.ref} 缺少去耦电容`;
                    warnings.push(msg);
                } else {
                    decaps.forEach(({ inst }) => {
                        const icSize = effSize(ic);
                        const capSize = effSize(inst);
                        const icCenterX = ic.x + icSize.w / 2;
                        const icCenterY = ic.y + icSize.h / 2;
                        const capCenterX = inst.x + capSize.w / 2;
                        const capCenterY = inst.y + capSize.h / 2;
                        const dist = Math.hypot(capCenterX - icCenterX, capCenterY - icCenterY);

                        if (dist > DECAP_MAX_DISTANCE) {
                            const msg = `去耦电容 ${inst.ref} 距离 ${ic.ref} ${Math.round(dist)}px (应 <${DECAP_MAX_DISTANCE}px)`;
                            warnings.push(msg);
                        }
                    });
                }
            }
        });

        const resetCircuits = this.findResetCircuit(core);
        resetCircuits.forEach(rc => {
            const coreSize = effSize(core);
            const coreCenterX = core.x + coreSize.w / 2;
            const coreCenterY = core.y + coreSize.h / 2;

            if (rc.resistor) {
                const rSize = effSize(rc.resistor);
                const dist = Math.hypot(rc.resistor.x + rSize.w / 2 - coreCenterX,
                    rc.resistor.y + rSize.h / 2 - coreCenterY);
                if (dist > RESET_MAX_DISTANCE) {
                    warnings.push(`复位电阻 ${rc.resistor.ref} 距离MCU ${Math.round(dist)}px (应 <${RESET_MAX_DISTANCE}px)`);
                }
            }

            if (rc.capacitor) {
                const cSize = effSize(rc.capacitor);
                const dist = Math.hypot(rc.capacitor.x + cSize.w / 2 - coreCenterX,
                    rc.capacitor.y + cSize.h / 2 - coreCenterY);
                if (dist > RESET_MAX_DISTANCE) {
                    warnings.push(`复位电容 ${rc.capacitor.ref} 距离MCU ${Math.round(dist)}px (应 <${RESET_MAX_DISTANCE}px)`);
                }
            }
        });

        const connectors = this.instances.filter(i => isConnector(i));
        let connectorOnEdgeCount = 0;
        connectors.forEach(conn => {
            const s = effSize(conn);
            const isOnEdge = (conn.x <= EDGE_MARGIN + 10) ||
                (conn.x + s.w >= this.W - EDGE_MARGIN - 10) ||
                (conn.y <= EDGE_MARGIN + 10) ||
                (conn.y + s.h >= this.H - EDGE_MARGIN - 10);
            if (isOnEdge) {
                connectorOnEdgeCount++;
            } else {
                warnings.push(`连接器 ${conn.ref} 未放置在边缘`);
            }
        });

        const powerConnectors = connectors.filter(c => this.classifyConnector(c) === 'POWER');
        powerConnectors.forEach(pwr => {
            const isOnLeftEdge = pwr.x <= EDGE_MARGIN + 10;
            if (!isOnLeftEdge) {
                warnings.push(`电源连接器 ${pwr.ref} 应放置在左侧边缘`);
            }
        });

        App.qualityReport = { criticals, warnings, connectorOnEdgeCount, totalConnectors: connectors.length };
        updateQualityIndicator();

        if (criticals.length > 0) {
            toast(`布局存在 ${criticals.length} 个严重问题，请查看报告`, 'warn', 5000);
        } else if (warnings.length > 5) {
            toast(`布局存在 ${warnings.length} 个警告，建议优化`, 'warn', 3000);
        }

        return { criticals, warnings };
    }

    place() {
        const core = this.chooseCore();
        if (!core) {
            console.warn(`未找到核心元件，无法进行布局`);
            return;
        }

        this.centerCore(core);

        this.placeCriticalPeripherals(core);

        this.placeConnectors();

        this.placeFunctionalClusters(core);


        const c3_final = this.byRef.get('C3');
        const r1_final = this.byRef.get('R1');
        if (c3_final && r1_final) {
            const dist = Math.hypot(c3_final.x - r1_final.x, c3_final.y - r1_final.y);

        } else {

        }

        this.validatePlacement();
    }
}