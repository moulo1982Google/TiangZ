# Rust 模块脚手架验收（2026-09-16）

## 本轮范围

TiangZ 的 modules:create / project:create 增加 `--with-rust`。手写模板集中在 `tools/templates/module-native`，通用创建逻辑在 `tools/scaffold_module_native.mjs`。模块保留 TS Model/Hotfix，附带 Rust crate、无状态加法 op、可单测的普通 Rust 函数、TS NativeExample 桥与中英文边界注释。没有新增 SLG 业务。

模块创建只输出手写输入；教学工程创建额外运行正式 Native/协议生成器。读取宿主 Cargo metadata 选择 deno_core 依赖要求，实际组合构建继续核验同一 crate 类型身份；不修改宿主 Cargo.toml，不复制引擎源码，不手改生成桥或锁。

修正 op-only schema 的模块代码生成：保留语言要求的抽象根，未声明具体实体时不输出 Rust 实体 Store/空枚举访问器，不为加法壳虚构实体。

`game_project.mjs` 的 setup/check/host-build/build/start/smoke 支持 Native。host-build 使用已有组合构建器；doctor/start/smoke 复用 module_runtime_binary 校验身份、源码指纹和二进制哈希。check 额外执行 Cargo check，会写编译缓存与组合工作区。自动 dev 仍明确拒绝 Native，不扩展后台编译/重启，不降级普通宿主。

Developer Tools 的新建入口增加 TypeScript / TypeScript + Rust 选择，只向宿主传参。取消选择或未确认不创建工程。已重建并本地安装 0.15.2 VSIX；没有更改发布版本、提交、推送或重载编辑器窗口。

## 实际通过

- `npm run verify:quick`：30/30，包含新增脚手架检查、原有 Native 实体/双模块生成回归、TS 检查、Rust fmt/Clippy/全部 target 测试。已有 Windows LNK4098 链接警告仍存在，不宣称零警告。
- `npm run test:module-native-scaffold-runtime`：正式脚手架创建带空格路径的工程、正式生成/TS 构建、组合 Rust 构建、模板 Rust 单测 1/1、Cargo check、真实 WebSocket 请求通过 Rust 加法返回 1/2、优雅停机、缺少/过期二进制拒绝、拒绝覆盖、重复参数拒绝、Native dev 拒绝及独立空模块生成。
- `npm run test:game-project`：原 TS-only 教学工程的真实双请求和正常停机回归通过。
- Developer Tools `npm run test:server`：扩展类型检查、构建和 38/38 测试通过，包含 Rust 选项传参及取消路径。
- Developer Tools `npm run package:extension`：VSIX 打包成功；VS Code CLI 本地强制更新同版本安装包成功。

首次测试发现仅抽象根的生成代码不能编译，已在生成器修正。额外 Rust 单测发现 op2 宏注册函数不能作为普通加法函数直接测试，已拆分算法与注册边界，并用重新创建的工程验证通过。

最新完整 Rust 夹具保留在 `temp/rust-scaffold-5eYkt3/game with spaces` 供检查；所有测试进程已停止，未操作既有游戏进程或数据库。

## 未做

未跑完整 `npm run verify`、发布验收、长稳、压测或 PostgreSQL/Redis 故障测试；不宣称生产部署或 Rust 自动监听已完成。VS Code 未人工点击走完整向导，交互分支由扩展 mock 测试验证，真实安装由 CLI 完成；用户需要重载窗口加载更新。
