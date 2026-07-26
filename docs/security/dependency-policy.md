# 依赖与许可证策略

TiangZ 的发布质量门同时检查 npm 与 Cargo 依赖。新增依赖必须具有明确用途，并优先选择维护活跃、许可证清晰且不会把业务层绑定到内部实现的库。

## 自动检查

- `npm run verify:dependency-policy`：校验所有漏洞例外都包含负责人、原因和到期日期，过期立即失败。
- `npm run audit:dependencies`：执行 npm 高危漏洞审计与 Cargo advisory 审计，并应用仍在有效期内的显式例外；CI 和正式 Release 必须执行。
- `Cargo.lock` 与 `package-lock.json` 必须提交；CI 使用 `cargo --locked` 和 `npm ci`。

## 例外规则

无法立即升级的漏洞只能写入 `security/dependency-exceptions.json`。每条例外必须包含 advisory id、生态、包名、负责人、具体原因和 `expiresOn`；禁止“暂时忽略”这类无期限说明。

许可证默认拒绝 AGPL、SSPL 以及没有明确授权的依赖。GPL/LGPL 或商业条款依赖必须在引入前单独评审其链接和分发方式。当前仓库没有许可证例外；后续如需例外，应与漏洞例外一样记录负责人、原因和复审日期。

安全审计依赖在线 advisory 数据，因此不放进每次本地 `verify:quick`，但它属于 CI 和发布候选验收的一部分。
