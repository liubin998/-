# 代码图谱 · 企业 IP 地址与网段资产管理平台

> 理念：**一切皆模块**。每个文件是一个职责单一的模块；每个能力有且只有一个归属模块。
> 后续迭代（问题优化）请先在本图谱中定位「能力 → 归属模块」，只修改归属模块及其直接契约。

## 一、架构分层

```
┌─────────────────────────────────────────────────────────────┐
│ 前端展现层 public/                                            │
│   app.js（入口）→ router.js（路由）→ views/*（9 个视图模块）      │
│                    └→ ui.js（通用组件）→ core.js（状态/API）     │
├─────────────────────────────────────────────────────────────┤
│ API 适配层 src/routes/     每个资源一个路由模块（鉴权+参数+包裹）   │
├─────────────────────────────────────────────────────────────┤
│ 领域层 src/domain/         业务规则与聚合（台账/诊断/事项/权限…）   │
│ 采集子系统 src/collector/   采集编排 / 对账引擎 / 探测 / 适配器     │
│ 导入子系统 src/import/      别名词典 / 预检 / 提交 / 文件解析      │
├─────────────────────────────────────────────────────────────┤
│ 基础设施 src/              db.js（连接）· schema.js（DDL）·      │
│                           config.js（配置）· scheduler.js（调度） │
└─────────────────────────────────────────────────────────────┘
依赖方向：上层 → 下层（单向）；domain 内 ip.js 为纯函数零依赖底座。
```

## 二、模块清单（精确命名与职责）

### 基础设施（`src/`）

| 模块 | 职责 | 关键导出 |
|---|---|---|
| `config.js` | 环境与运行配置（端口/数据目录/令牌/调度间隔/探测限流） | `config` |
| `db.js` | SQLite 连接引导（建连接、开 WAL/外键、应用 Schema、时间戳工具） | `db` `now()` |
| `schema.js` | 数据库结构定义（29 张表 + 索引的 DDL） | `applySchema(db)` |
| `seed.js` | 初始数据播种（管理员/分支/网段/台账/设备/角色能力点） | `seed()` |
| `scheduler.js` | 周期调度器（定时采集/对账/过期观测清理 + 状态上报） | `startScheduler` `schedulerStatus` |
| `server.js` | HTTP 服务组装（中间件顺序、路由挂载、静态资源、启动） | `createApp()` |

### 领域层（`src/domain/`）

| 模块 | 职责 | 关键导出 |
|---|---|---|
| `ip.js` | **IP/CIDR 规则引擎**（纯函数零依赖）：IPv4/IPv6 解析与格式化、掩码⇄前缀、CIDR 边界计算、包含/重叠/关系判定、容量与保留数 | `toBuffer` `parseCidr` `cidrRange` `relation` `capacity` 等 |
| `subnet.js` | 网段聚合：创建（完全重复 409）/更新/删除（解绑台账）、最长前缀匹配、全局重叠报告 | `createSubnet` `longestPrefixMatch` `overlapReport` |
| `ipLedger.js` | IP 台账聚合：upsert/状态机、分配与释放、网段内空闲推荐 | `upsertIp` `assignIp` `releaseIp` `findFreeInSubnet` |
| `observations.js` | 现场观测数据：记录/按条件查询、证据时间窗口（全局/分支/设备三级）、过期清理 | `recordObservation` `queryObservations` `windowFor` |
| `diagnosis.js` | **诊断规则引擎**：证据新鲜度×设备可用性×强弱证据 → 六级现场结论 + 三类台账冲突识别 | `diagnoseIp` `FIELD_STATUS` |
| `tickets.js` | 协同事项聚合：创建（ticket_key 去重）/状态流转/处理记录 | `createTicket` `updateTicket` `addComment` |
| `devices.js` | 设备注册表聚合：注册/更新/状态标记、角色与协议常量 | `createDevice` `markDeviceStatus` |
| `auth.js` | 认证：密码哈希、令牌签发与解析、角色→能力点映射 | `login` `issueToken` `userFromToken` `CAPS` |
| `authHelpers.js` | 授权中间件：Bearer 鉴权、能力点校验、分支越权断言、分支/授权管理 | `authMiddleware` `requireCap` `assertBranch` |
| `audit.js` | 审计日志：敏感字段脱敏后落库 | `recordAudit` |
| `ai.js` | AI 查询助手：意图解析 → 规则引擎/台账检索 → 权限过滤组装答复 | `answerQuestion` |
| `util.js` | 通用纯函数工具箱：脱敏/分页/JSON 列/MAC 归一/差异比较/枚举校验 | `redact` `paged` `normalizeMac` 等 |

### API 适配层（`src/routes/`，一资源一模块）

| 模块 | 挂载点 | 职责 |
|---|---|---|
| `auth.js` | `/api/auth` | 登录/登出/会话信息 |
| `subnets.js` | `/api/subnets` | 网段 CRUD、空闲推荐、重叠报告、网段诊断 |
| `ips.js` | `/api/ips` | 台账 CRUD、分配/释放、主动探测、单点诊断 |
| `devices.js` | `/api/devices` | 设备注册/连接测试/单设备采集/采集历史 |
| `imports.js` | `/api/import` | 文件上传（multipart）、批次预检/提交/追溯/错误清单 |
| `tickets.js` | `/api/tickets` | 协同事项列表/详情/状态流转/评论 |
| `audit.js` | `/api/audit` | 审计日志分页检索（分支过滤） |
| `dashboard.js` | `/api/dashboard` | 仪表盘汇总统计 + 调度器状态 |
| `search.js` | `/api/search` | 全局搜索（IP/网段/设备/事项，权限过滤） |
| `ai.js` | `/api/ai` | AI 问答入口 |
| `admin.js` | `/api/admin` | 分支组织/用户授权/诊断时间窗口管理 |
| `errors.js` | （内部） | 异步包裹、HTTP 错误工厂、统一错误/404 中间件 |
| （`server.js` 内） | `/api/collect/run` `/api/reconcile/run` | 全量采集/对账的手动触发端点 |

### 采集子系统（`src/collector/`）

| 模块 | 职责 |
|---|---|
| `collect.js` | 采集编排：/24 分片计划、按厂商派发适配器、观测落库、完整性标记、运行记录 |
| `reconcile.js` | **对账引擎**：新鲜观测 × 台账比对 → 生成五类协同事项（多 MAC 冲突/未登记占用/空闲在用/MAC 不符/占用无证据）+ 设备离线事项 |
| `probe.js` | 主动探测：限流内的 ICMP/TCP 探测，写观测作为辅助证据 |
| `simulator.js` | 模拟世界生成器（无真实设备时按分支生成仿真在线用户/表项） |
| `adapters/sangfor.js` | 深信服 AC 适配器（版本/健康/在线用户分片查询/IP-MAC 绑定 + 错误归因） |
| `adapters/huawei.js` | 华为交换机适配器（连接测试/ARP 表/MAC 表） |

### 导入子系统（`src/import/`）

| 模块 | 职责 |
|---|---|
| `aliases.js` | **映射契约**：表头中文别名词典 + 业务状态别名词典 + 状态映射 |
| `pipeline.js` | 导入流水线：文件登记入库 → 行级四级预检（ok/warning/error/conflict）→ 确认式提交（覆盖/不覆盖）→ 行级追溯（批次+行号）→ 重复提交防护 |
| `csv.js` | CSV 解析器（引号/逗号/换行转义） |
| `xlsx.js` | XLSX 最小解析器（sharedStrings/sheet XML） |
| `zip.js` | ZIP 容器解析 + inflate 解压 |

### 前端（`public/`）

| 模块 | 职责 |
|---|---|
| `index.html` | 页面外壳（仅标记 + 资源引用） |
| `css/app.css` | 设计系统样式（布局/表格/徽章/模态/登录页） |
| `js/core.js` | 应用核心：全局状态、API 客户端（401 自动登出）、会话、文案与徽章映射、HTML 转义等格式化工具 |
| `js/ui.js` | 通用 UI 组件：布局外壳、能力点过滤导航、模态框、表单域、分支选择器、分页器 |
| `js/router.js` | 哈希路由与渲染调度（含登录页与全局搜索结果页） |
| `js/app.js` | 前端入口：装配路由、注册 hashchange、启动首帧渲染 |
| `js/views/dashboard.js` | 仪表盘视图（统计卡/状态分布/调度器/最近采集） |
| `js/views/subnets.js` | 网段管理视图（列表/筛选/详情/新增/编辑/删除/重叠检测/空闲推荐/网段诊断） |
| `js/views/ips.js` | IP 台账视图（列表/筛选/详情/登记/编辑/分配/释放/主动探测/现场诊断面板） |
| `js/views/devices.js` | 设备与采集视图（注册/连接测试/单设备采集/采集历史/全量采集/对账触发） |
| `js/views/tickets.js` | 协同事项视图（列表/筛选/详情/新建/状态流转/处理记录） |
| `js/views/import.js` | 导入中心视图（上传/批次列表/预检预览/覆盖确认入库/行级追溯） |
| `js/views/audit.js` | 审计日志视图（操作/用户/对象类型筛选） |
| `js/views/ai.js` | AI 查询助手视图（快捷提问/对话流/结果表格/注意事项） |
| `js/views/admin.js` | 系统管理视图（分支组织/用户与授权/诊断时间窗口三页签） |

### 测试与验收脚本

| 模块 | 职责 |
|---|---|
| `test/ip.test.js` | IP/CIDR 规则引擎单元测试（22 项，纯函数） |
| `test/diagnosis.test.js` | 诊断规则引擎单元测试（9 项，隔离临时数据库） |
| `test/import.test.js` | 导入流水线单元测试（6 项，隔离临时数据库） |
| `scripts/smoke.mjs` | 全链路 API 冒烟（24 项：认证/仪表盘/网段/IP/设备/事项/审计/AI） |
| `scripts/import_test.mjs` | 导入全链路验收（15 项：上传/预检/提交/追溯/409 防护/覆盖模式） |

## 三、关键依赖关系

```
server.js ──→ routes/* ──→ domain/* ──→ db.js ──→ schema.js
   │              │            ↑              ↑
   ├→ scheduler.js ─→ collector/{collect,reconcile,probe} ─→ collector/adapters/*
   │                        └──────→ domain/observations · tickets · audit
   └→ seed.js ──→ domain/{auth,authHelpers,subnet,ipLedger,devices}

import/pipeline ──→ import/{aliases,csv,xlsx} · domain/{ip,subnet,util}

前端：app.js → router.js → views/* → {core.js, ui.js}；ui.js → core.js
（views ⇄ router 的循环引用由 ESM 函数提升保证安全，仅发生在 render 调用时）
```

## 四、迭代约定（问题优化模块）

1. **定位归属**：先在第二节找到能力所属模块；一个问题只应落到一个归属模块。
2. **契约边界**：跨模块交互只走表格中列出的导出；新增能力优先扩展归属模块的导出，而非新建平行逻辑。
3. **验证闭环**：领域逻辑改动 → 补/改 `test/` 对应单测；API 行为改动 → 跑 `scripts/smoke.mjs`；导入行为改动 → 跑 `scripts/import_test.mjs`；前端改动 → 浏览器实测对应视图。
4. **禁止**：在路由层写业务规则、在视图模块里直接操作非本视图 DOM、在前端硬编码后端字段别名。

## 五、已知能力矩阵（能力 → 归属模块速查）

| 能力 | 归属模块 |
|---|---|
| IP/网段解析与数学 | `domain/ip.js` |
| 重叠识别（警告非阻断） | `domain/subnet.js` + `routes/subnets.js` |
| 台账状态机与分配 | `domain/ipLedger.js` |
| 现场结论判定 | `domain/diagnosis.js` |
| 证据有效期窗口 | `domain/observations.js` + `routes/admin.js`（配置 UI） |
| 冲突→协同事项生成 | `collector/reconcile.js` |
| 导入行级追溯 | `import/pipeline.js` |
| 中文表头识别 | `import/aliases.js` |
| 权限能力点 | `domain/auth.js`（定义）+ `domain/authHelpers.js`（执行） |
| 前端视图渲染 | `public/js/views/<对应视图>.js` |
