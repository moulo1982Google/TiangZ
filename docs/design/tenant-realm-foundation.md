# 租户、区服与合服边界（2026-09-16）

tenantId 表示游戏运营环境；realmId 是当前逻辑服；originServerId 是永久来源身份。持久 GlobalId 不因合服改变，InstanceId 只用于当前运行实例。Process、数据库位置与逻辑身份分离。

用户确认的 SLG 设计是：合服创建新世界、地块重新争夺，不合并旧地图坐标和占领。这不是已实现的 Demo 业务，也不是 TiangZ 的通用规则。旧行军、定时任务和占领事件如何隔离或结算，由未来 SLG 迁移器负责。

## 本次实现

- DBProxy --tenants 通过认证凭据绑定独立后端及连接预算，v1 使用不同 PostgreSQL database、Redis 逻辑 DB；同实例共享不代表独立资源/故障域。
- tools/realm_merge_plan.mjs 提供只读区服目录校验、确定性计划及阶段操作键。未知字段、跨租户、重复来源服、旧区服代次、已开放目标服均拒绝。
- 计划使用完整输入指纹，相同输入重试得到相同结果。所有阶段 pending、executable=false：不是执行器，不停服、不写库、不切路由，也不执行补偿。
- SLG 的 configs/realms 和 realm:plan 提供两个源服进入新世界的示例；未接入当前 SlgWorld 启动，不宣称只读 Demo 已具备正式分服/合服能力。

## 开发者入口与归属（格式 v2）

三份输入都是手写声明，输出计划是生成物：

| 输入 | 谁维护 | 内容 |
| --- | --- | --- |
| catalog.json | 游戏部署维护者 | tenantId、区服、永久来源编号、状态、realmGeneration |
| request.json | 本次合服维护者 | operationId、源服、目标服、policyId、未决业务 |
| 模块 policies/realm-merge.json | 游戏模块作者 | ownerModuleId、policyId、revision、domain/action 决策 |

```powershell
node tools/realm_merge_plan.mjs --catalog <catalog.json> --request <request.json> --policy <模块策略.json>
```

目录、请求和输出由格式 1 升为 2，旧 worldGeneration 改为 realmGeneration，worldPolicy 改为显式 policyId；不静默迁移旧文件。策略信封为格式 1。策略 ID 必须属于声明的 ownerModuleId 命名空间，并与请求一致；策略内容和 revision 全部进入 planHash。策略必须是纯 JSON，无脚本、SQL 或自动执行 Hook。

框架只验证信封、领域名不重复等结构，不解释 action 字符串，不证明策略覆盖全部业务，也尚未将 ownerModuleId 与实际发布模块图绑定。它不把模块策略装载为运行时插件。未决清单为空仍为 executable=false；正式执行器必须补模块身份/制品校验、领域验证器和迁移回执。

realmGeneration 是逻辑服切换代次，不替代游戏自己的世界、赛季或副本版本。框架阶段为 fence/settle/snapshot/migrate/verify/cutover，不再含“地图重建”阶段。SLG 的重建规则位于 Examples/packages/slg/modules/slg/policies/realm-merge.json；其他游戏可声明完全不同的动作，不必修改宿主。Developer Tools 将来只呈现这些输入、诊断与计划，不复制业务策略或执行器。

## 正式执行器的准入条件（尚未实现）

1. 排他迁移租约与单写者 fencing 由权威存储校验，不接受本地布尔值冒充屏障。
2. 封禁所有源服写入与旧世界消息；不能只关登录入口。拒绝迟到普通快照覆盖新归属。
3. 行军、交易、邮件/奖励、排队写、Outbox（包括已领取未处理任务）按业务规则结算和对账。
4. 一致备份与恢复演练，持久身份、资产、关系对账基线。SaveMulti 的部分成功语义不能代替合服事务。
5. 领域迁移器按模块策略处理数据，提供幂等回执。SLG 未来不导入旧占领；资产、公会、入场位置和补偿尚无完整业务，保持未决而非预填完成。
6. 最终目录 CAS、目标单写者开放、旧选服入口重定向。新服接受写入后，恢复旧备份不再是无损回滚。

DBProxy 不解释城池、公会或合服阶段。游戏模块拥有领域政策；TiangZ 工具拥有目录、计划和校验；develop-tools 将来呈现同一份计划，不另写迁移逻辑。

## ID 分配准入项

GlobalIdSystem 新增显式 DBProxy 号段模式，先持久 CAS 预留再本地发号，保留现有位布局；旧 local-development 模式仍不保证跨重启唯一。见[号段机制、切换与恢复约束](global-id-ranges.md)。未切换现有部署、未验收真实 PostgreSQL/Redis 恢复，不宣称数据库回滚后仍唯一；永久来源编号不可自动回收。
