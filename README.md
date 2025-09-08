# 原理图自动生成工具 V2.33 (模块化版)

一个基于Web的电子电路原理图自动布局布线工具，支持从网表文件自动生成美观的电路原理图。

## 🚀 主要特性

### 核心功能
- **自动布局布线**: 智能算法自动放置元件并连接导线
- **多格式支持**: 支持JSON和Protel(.net)网表格式
- **SVG符号库**: 支持导入自定义SVG符号库
- **实时交互**: 支持拖拽移动元件、旋转元件等交互操作
- **质量评估**: 自动评估布局质量并提供优化建议
- **schdoc导出**: 实时导出Altium Designer兼容的schdoc文件

### 智能优化
- **关键电路优化**: 针对MCU、晶振、去耦电容等关键元件的特殊布局策略
- **复位电路优化**: 将R1和C1作为整体优先放置，修复分离问题
- **去耦电容优化**: 确保去耦电容靠近电源引脚
- **重复电路识别**: 自动识别并优化重复电路组（如按钮、LED等）
- **总线布线**: 为重复电路组创建共用电源/地母线

### 布线策略
- **多级布线算法**: 从简单直线到复杂A*路径搜索
- **分道布线**: 避免导线交叉，支持多车道布线
- **电源符号自动放置**: 智能放置VCC和GND符号
- **网络标签**: 自动生成网络标签，支持多种放置策略

## 📁 项目结构

```
auto-placementV1.1/
├── index.html              # 主页面
├── main.js                 # 应用入口
├── style.css               # 样式文件
├── config.js               # 配置参数
├── state.js                # 全局状态管理
├── interaction.js          # 用户交互处理
├── placement.js            # 布局算法引擎
├── routing.js              # 布线算法引擎
├── optimization.js         # 优化算法
├── component.js            # 元件管理
├── drawing.js              # 绘图功能
├── fileHandlers.js         # 文件处理
├── symbol.js               # 符号库管理
├── geometry.js             # 几何计算
├── quality.js              # 质量评估
├── utils.js                # 工具函数
├── view.js                 # 视图控制
├── schdocWriter.js         # schdoc文件写入引擎
├── schdocSync.js           # schdoc实时同步管理器
├── schdocMapper.js         # schdoc数据映射层
└── test_schdoc.html        # schdoc功能测试页面
```

## 🏗️ 架构设计

### 模块化架构
项目采用模块化设计，遵循单一职责原则：

- **状态管理** (`state.js`): 集中管理应用状态
- **配置管理** (`config.js`): 统一管理所有配置参数
- **布局引擎** (`placement.js`): 负责元件自动布局
- **布线引擎** (`routing.js`): 负责导线自动布线
- **优化引擎** (`optimization.js`): 负责布局优化
- **交互控制** (`interaction.js`): 处理用户交互
- **绘图系统** (`drawing.js`): 负责SVG绘制
- **schdoc导出** (`schdocWriter.js`, `schdocSync.js`, `schdocMapper.js`): 负责schdoc文件生成和实时同步

### 数据流
```
网表文件 → 文件处理 → 状态管理 → 布局引擎 → 布线引擎 → 绘图系统 → SVG输出
                                    ↓
                               schdoc同步器 → schdoc文件输出
```

## 🎯 核心算法

### 布局算法 (PlacementEngine)
- **分层布局**: 核心元件优先，外围元件后置
- **约束优化**: 关键电路距离约束
- **聚类分析**: 相关元件就近放置
- **重复电路识别**: 自动识别相似电路模式

### 布线算法
- **多级路径搜索**:
  1. 直线路径 (tryStraightPath)
  2. L型路径 (tryLPath) 
  3. Z型路径 (tryZPath)
  4. A*算法 (aStarRoute)
- **分道布线**: 避免导线交叉
- **总线布线**: 重复电路共用母线

### 优化算法
- **旋转优化**: 自动优化二端元件旋转角度
- **距离优化**: 关键电路距离约束
- **路径优化**: 简化布线路径

## 🛠️ 使用方法

### 1. 导入符号库
- 点击"导入SVG库"按钮
- 选择包含元件符号的SVG文件
- 支持批量导入多个文件

### 2. 导入网表
- 点击"导入网表"按钮选择文件
- 或在文本框中直接粘贴网表内容
- 支持JSON和Protel(.net)格式

### 3. 自动布局布线
- 点击"自动布局 + 布线"按钮
- 系统将自动完成元件布局和导线连接
- 可调整布线策略：自动/标准/紧凑

### 4. 交互调整
- **移动元件**: 拖拽元件到新位置
- **旋转元件**: 选中元件后按空格键
- **重新布线**: 移动元件后自动重新布线

### 5. 导出结果
- **导出原理图**: 保存为SVG格式
- **导出网表**: 保存为JSON格式
- **导出schdoc**: 保存为Altium Designer兼容的schdoc格式

### 🔧 schdoc 导出流程与注意事项

1) 如何导出

- 在页面中点击“导出 schdoc”按钮；或在控制台/代码里调用：

```javascript
import { schdocSync } from './schdocSync.js';
await schdocSync.exportSchdoc('schematic.schdoc');
```

- 导出会先全量同步当前 Canvas 状态，再生成下载文件。

2) 同步与生成机制（概览）

- `schdocSync.syncToSchdoc()`：
  - 清空历史记录 → 预加载 `svglib/*.schdoc` 模板 → 根据 `App.inst / App.wires / App.netLabels` 重建记录。
  - 元件：优先按 `ref`（如 `R1`、`C7`、`IC1`、`RP1`）到 `svglib` 中寻找同名模板；不存在则回退到内置占位实现。
- `schdocWriter.exportSchdoc()`：
  - 生成 Header/Sheet 与逐条 RECORD，并发起浏览器下载。

3) 坐标与网格

- 全部坐标会按 `GRID` 对齐（见 `config.js` 中 `GRID`）。
- 坐标转换采用 `SCHDOC_CONFIG`：
  - `COORDINATE_SCALE`：单位缩放（默认 1）。
  - `INVERT_Y`：Y 轴翻转（与 AD 的 Sheet 坐标系一致）。
  - `SHEET_WIDTH/HEIGHT`：画布到 Sheet 的尺寸映射。

4) 模板锚点与特殊器件

- 默认锚点优先级：引脚质心 → 组件记录 LOCATION → 主矩形(14/10)中心 → 图形外框中心 → 全记录外框中心。
- 仅对电位器（`RP*`/`POT*`）启用专门对齐：
  - 若模板由四条 `RECORD=13` 直线构成外框，则优先取该矩形中心；
  - 放置时以“左右端水平引脚的中线中心”为目标位置，避免因滑动端导致的上/下偏移；
  - 该逻辑严格限定到 `RP*`/`POT*`，不会影响 IC 等其它元件。

5) 导出文件名与路径

- 默认下载为 `schematic.schdoc`。你也可以传入自定义文件名：`exportSchdoc('my_design.schdoc')`。
- `SCHDOC_CONFIG.SCHDOC_FILE_PATH` 仅作默认路径标识，不会强制写磁盘，实际以浏览器下载为准。

6) 常见排查

- 元件错位：检查 `svglib/同名.schdoc` 是否存在，以及 `INVERT_Y/SHEET_HEIGHT` 是否匹配；必要时调整 `COMPONENT_OFFSET_* / PER_LIB_BIAS`。
- 单个器件仍有半格偏移：确认其是否在 `GRID` 节点；或开启/关闭 `AUTO_FINE_ALIGN` 做对比。

## ⚙️ 配置参数

### 布局参数
```javascript
// 关键电路约束
CRYSTAL_MAX_DISTANCE = 30    // 晶振到MCU最大距离
DECAP_MAX_DISTANCE = 25      // 去耦电容到电源引脚最大距离
RESET_MAX_DISTANCE = 35      // 复位电路元件最大距离
CORE_MARGIN = 24             // 核心元件周围边距
```

### 布线参数
```javascript
LANE_SPACING = 10            // 标准车道间距
LANE_SPACING_TIGHT = 6       // 紧凑车道间距
ROUTE_STUB = 18              // 标准布线桩长度
ROUTE_STUB_IC = 36           // IC布线桩长度
```

### schdoc导出参数
```javascript
SCHDOC_CONFIG = {
  ENABLE_REALTIME_SYNC: true,           // 启用实时同步
  SCHDOC_FILE_PATH: './output/schematic.schdoc', // 默认输出路径
  COORDINATE_SCALE: 100,                // Canvas单位到schdoc单位的转换比例
  AUTO_SAVE_INTERVAL: 5000,             // 自动保存间隔(ms)
  DEFAULT_COLORS: { ... },              // 默认颜色配置
  PIN_LENGTHS: { ... },                 // 引脚长度配置
  POWER_PORT_STYLES: { ... }            // 电源端口样式配置
}
```

## 📊 质量评估

系统会自动评估布局质量并显示：
- **成功率**: 成功布线的网络比例
- **优化数量**: 自动优化的元件数量
- **关键电路**: 识别的关键电路数量
- **质量等级**: 优秀/良好/一般/需改进

## 🔧 技术栈

- **前端**: 原生JavaScript (ES6+)
- **图形**: SVG + Canvas
- **算法**: A*路径搜索、聚类分析、约束优化
- **架构**: 模块化设计、事件驱动

## 🚀 性能优化

- **增量更新**: 只重绘变化的元素
- **路径缓存**: 缓存常用路径计算结果
- **分块处理**: 大电路分块处理避免卡顿
- **异步处理**: 文件加载和复杂计算异步执行

## 🎨 界面特性

- **响应式设计**: 适配不同屏幕尺寸
- **暗色主题**: 护眼的暗色界面
- **实时反馈**: 操作即时响应
- **状态指示**: 清晰的状态和进度提示

## 📝 开发说明

### 代码规范
- 遵循ES6+标准
- 使用模块化导入/导出
- 函数命名采用驼峰命名法
- 常量使用大写字母

### 扩展开发
- 新增布局算法：继承PlacementEngine基类
- 新增布线策略：在routing.js中添加新函数
- 新增优化算法：在optimization.js中实现
- 新增文件格式：在fileHandlers.js中添加解析器

## 🔄 版本历史

### V2.33 (当前版本)
- 修复复位电路R/C分离问题
- 将R1和C1作为整体优先放置
- 增加邻近放置辅助函数
- 保留原有的去耦电容优化
- 增强重复电路识别和总线布线
- **新增schdoc实时导出功能**
- 支持Altium Designer兼容的schdoc文件格式
- 实时同步Canvas绘制到schdoc文件
- 完整的元件、导线、网络标签映射

### 主要改进
- 模块化重构，提高代码可维护性
- 优化布局算法，提高布局质量
- 增强布线算法，减少导线交叉
- 改进用户交互体验

## 📄 许可证

本项目为开源项目，遵循MIT许可证。

## 🤝 贡献

欢迎提交Issue和Pull Request来改进项目。

---

*原理图自动生成工具 - 让电路设计更简单*
