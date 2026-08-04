# TiangZ开发记忆

## 工程与协作约定

- 每次开始 TiangZ 相关任务前，先读取本文件；它是项目协作规则和历史决策的第一入口，不先扫描外部上下文。
- 主工程目录固定为 `E:\gitee\TiangZ`，不要误操作 `E:\VsCode\skynet`。
- 默认使用中文交流、中文文档和中文 Git 提交信息。
- 架构或业务语义变更必须同步更新 `docs/ai/project-context.md` 和 `docs/ai/business-development-manual.md`。
- Core、Demo 和 Rust 层的函数注释使用中英文对照，说明作用、副作用、禁止用法和设计原因。
- 需要高 CPU 或长时间压测前先告知；验收以真实运行结果、构建产物、服务器状态或客户端画面为准。

## TiangZ架构

- 运行时主层次为 `Process -> Scene -> Component -> Entity/Unit`。
- 一个 Process 对应一个 V8；Process 是部署和 V8 隔离边界，Scene 是业务上下文和消息范围。
- Scene Event 不能跨 Scene；跨 Scene、跨 Process 或需要 mailbox 顺序时使用 Message/RPC。
- 业务优先使用 `AddComponent`、`GetComponent`、`RemoveComponent`，不要为简单功能增加额外胶水层。
- Unit、Item、Buff、Quest 等子对象遵循 Entity 生命周期语义。
- `Awake`、`Destroy`、`Deserialize`、`Transfer` 是可选能力；恢复后的业务加工由 Hotfix System 实现，框架只负责调用时机。
- Model 不热更，Hotfix 可以热更；稳定数据结构、Native schema、冷热标记和类型边界属于 Model/生成边界。
- Rust 负责权威数据、批量热路径、Native Entity/Unit/Item、AOI 和编码；TS 通过句柄/FastOP 使用，是否频繁调用由开发者决定，框架不阻止。

## 动态地图与路由

- 静态地图和动态副本共用 `MapHostScene/MapHostComponent`，通过 `staticMapIds` 和 `acceptDynamicMaps` 区分静态、动态或混合承载。
- `MapManager` 负责动态 MapHost 注册、心跳、租约、幂等创建和 MapInstance 分配。
- `MapConfigId` 是地图模板，`MapInstanceId` 是运行时路由权威。静态和动态地图都使用同一套 `TransferToMap(mapInstanceId)` 业务流程。
- `Location` 保存玩家当前 MapInstance 和完整 MapHost Endpoint，用于路由查询，不应成为所有消息的流量中心。
- `knownSceneFiles` 是共享稳定启动拓扑，属于启动配置，不是运行时服务发现；新增空载副本 Host 不需要修改其他进程的 Scene 配置。

## AOI约定

- Cell 是基础空间单位；2D 可以以 Cell 为移动单位，3D 可以在 Cell 内连续移动。
- 默认一个 AOI Grid 为 `15 x 15 Cell`，AOI 关系按 Grid 边界计算，不按 Cell 边界计算。
- Rust 主方案为 Flat Grid + `Vec<EntityIndex>` + `slotInGrid`，跨 Grid 使用 O(1) swap-remove/push。
- Observer/Subject 使用双向连续位图；热点 Grid 使用稀疏数组和位图混合策略。这些是 Rust 内部优化，业务不依赖签名或缓存细节。
- 默认同步层级：`3 x 3 Grid` 为 Enter/高频 20Hz，`5 x 5 Grid` 为 Leave 迟滞/中频 5Hz；暂不使用 7 x 7。
- 业务通过 MapComponent 的 Audience/Publish API 广播，不能自行维护 AOI 关系表或绕过地图生命周期。
- AOI 只筛选接收者；阵营、隐身、位面、队伍权限等业务规则由业务提供同步查询接口。

## 战斗时间轴约定

- 自动攻击状态和自动攻击读条分离。`StartAutoAttack`只激活状态并锁定目标，不代表立即造成伤害。
- 只有目标存活、同一MapInstance、距离在攻击范围内且朝向有效时，才开始推进平A读条。
- 离开攻击范围或朝向失效时，平A状态不取消，但当前读条清零；重新满足条件后必须从0秒重新开始读条，不能恢复离开前的进度。
- 移动本身不调用`StopAutoAttack`；右键加A/D用于保持角色朝向并侧移绕目标，右键拖动改变角色的权威Yaw。
- 普通攻击、瞬发技能和施法技能分开描述：伤害类型、执行方式、是否重置平A是三个独立配置维度。

## 3D客户端与导航

- 3D 地图使用 NavMesh3D、离线导航资源和动态门障碍；角色与怪物之间的动态避让明确不做。
- 后端坐标统一为 `x/y/z: float32`，前端转换为各引擎自己的 `Vec3/Vector3/float3`，引擎类型不能进入协议。
- Cocos3D、UE、Godot 共享协议和 SDK，但各自负责输入、摄像机和表现层坐标转换。
- Cocos3D、UE、Godot 的 A/D 方向必须以实际画面验收：A 向视觉左侧转，D 向视觉右侧转。
- Cocos3D 按住鼠标右键时：A 向左平移，D 向右平移。不能只依据代码中的正负号判断，必须验证最终画面。

## Cocos构建与发布

- 构建前清除 `ELECTRON_RUN_AS_NODE`，统一使用：
  - `npm run build:cocos3d:web`
  - `npm run build:cocos3d:mobile`
  - 对应 `:debug` 命令仅用于调试。
- 构建脚本负责匹配 Creator 版本、清理标准输出、校验 `index.html/application.js/assets`；Creator code 36 只有在完整产物存在时才接受。
- 编辑器 Preview 使用 `assets/resources/Config/tiangz-local.json`，连接本机 `127.0.0.1:7000`。
- 非 Preview 发布包使用 `tiangz-external.json`，连接公网 LoginMgr；本地和外网配置不能混用。
- 外网桌面资源部署到 `/var/www/tiangz-cocos3d/desktop`，网址为 `/`；手机资源部署到 `/var/www/tiangz-cocos3d/m`，网址为 `/m/`。
- 外网后端只上传 Linux Release 制品，不上传源码、Cargo 工程、`node_modules` 或 `target`；运行目录为 `/opt/tiangz-external`。
- 用户说“部署到外网测试机”时，默认重新生成代码、构建后端 Release、构建 Cocos3D Web、上传并复验 Nginx 和登录链路；凭据不能写入仓库或日志。

## 当前状态与待办

- 最近提交：`dd68e08 完善怪物演示与Cocos3D发布配置`。
- 当前外网桌面版和 `/m/` 已使用最新 Cocos3D 包，页面 HTTP 200；前端发布不会自动重启后端。
- 标准 Cocos3D Web 包约 7.4 MB 原始大小，主要是 Cocos 核心、Bullet/Ammo、Spine 和内置渲染资源。小游戏 5 MB 主包需要独立轻量构建，不能直接拿标准 Web 包提交。
- 小游戏轻量包候选方向：移除未使用的 Bullet/Spine、主包只放启动链路、地图和资源放分包/远程资源，并增加 4.5 MB 构建预算检查。
- AOI 动态避障、角色/怪物动态避让和生产级持久化按路线图推进，不要在 Demo 中扩大范围。

## 常用验证命令

```powershell
npm run codegen
npm run verify:codegen
npm run typecheck
npm run typecheck:cocos3d-demo
npm run typecheck:cocos-net
npm run build:cocos3d:web
npm run build:cocos3d:mobile
```

## 3D客户端左右输入约定

- TiangZ当前3D坐标和Yaw约定下，Cocos3D、UE、Godot等客户端的A/D左右转向必须以实际画面验收，不能只看代码表达式。
- 约定：按A应向视觉左侧转，按D应向视觉右侧转。
- 手机虚拟摇杆横轴也必须遵循同一约定：摇杆向左对应A，摇杆向右对应D。
- 修改输入映射、Yaw转换或相机跟随时，必须补一次客户端画面回归，避免引擎正方向与TiangZ正方向再次反转。
