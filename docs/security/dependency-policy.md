# 依赖与许可证策略

TiangZ 的发布质量门同时检查 npm 与 Cargo 依赖。新增依赖必须具有明确用途，并优先选择维护活跃、许可证清晰且不会把业务层绑定到内部实现的库。

## 自动检查

- `npm run verify:dependency-policy`：校验所有漏洞例外都包含负责人、原因和到期日期，过期立即失败。
- `npm run audit:dependencies`：执行 npm 高危漏洞审计与 Cargo advisory 审计，并应用仍在有效期内的显式例外；CI 和正式 Release 必须执行。
- 开发阶段允许依赖解析随代码一起迭代，使用`npm install`和普通Cargo命令即可；准备发布时，才使用提交后的锁文件运行`npm ci`、`cargo ... --locked`并保存构建产物，确认发布依赖解析不可变。

## 例外规则

无法立即升级的漏洞只能写入 `security/dependency-exceptions.json`。每条例外必须包含 advisory id、生态、包名、负责人、具体原因和 `expiresOn`；禁止“暂时忽略”这类无期限说明。

许可证默认拒绝 AGPL、SSPL 以及没有明确授权的依赖。GPL/LGPL 或商业条款依赖必须在引入前单独评审其链接和分发方式。当前仓库没有许可证例外；后续如需例外，应与漏洞例外一样记录负责人、原因和复审日期。

安全审计依赖在线 advisory 数据，因此不放进每次本地 `verify:quick`，但它属于 CI 和发布候选验收的一部分。

## 仓库内固定源码

| 目录 | 版本 | 许可证 | 用途 |
|---|---|---|---|
| `third_party/kcp` | 固定上游提交，见目录README | MIT | 可选KCP可靠UDP传输 |
| `third_party/recastnavigation` | `v1.6.0` / `6dc1667f580357e8a2154c28b7867bea7e8ad3a7` | zlib | 离线Recast烘焙与只读Detour查询 |

固定源码必须保留上游许可证和TiangZ版本说明。升级时不得覆盖项目适配层，必须重新执行对应专项测试，并在发布前验证Windows与Linux编译；Recast/Detour适配位于`src/native/navmesh_shim.*`，不是直接修改上游源码。
