# Rust 扩展从哪里开始

这是 TS 模块附带的 Rust 壳，不是纯 Rust Scene/Handler，也不是动态 DLL 插件。

- 手写：`native/Example.native` 声明接口；`rust/src/native_data.rs` 实现加法；`src/model/NativeExample.ts` 提供 TS 调用示例；`rust/Cargo.toml` 和 `rust/src/lib.rs` 是 crate 接入入口。
- 生成：`rust/src/generated/` 和 `src/model/generated/native/`。不要手改；修改 `.native` 后重新运行正式生成器。
- Hotfix 从 `#tiangz/module` 导入 `NativeExample`，调用 `NativeExample.Add(2, 3)`；不要深层导入 Model 或手写 op 名称。
- 示例无状态，不分配实体，不连接数据库。增加原生状态时需要自行明确 Store 所有权和释放语义。

## 独立模块

在 TiangZ 主工程运行，`<模块父目录>` 是包含本模块的目录：

```text
node tools/prepare_game_modules.mjs --modules-dir <模块父目录> --host-profile modules
node tools/codegen_module_native.mjs --modules-dir <模块父目录>
node tools/typecheck_game_modules.mjs --modules-dir <模块父目录> --host-profile modules
node tools/build_module_native.mjs --modules-dir <模块父目录>
node tools/build_runtime_bundles.mjs --modules-dir <模块父目录> --host-profile modules --out-dir <工程目录>/dist
```

使用组合构建报告的二进制及匹配 Model；空模块不自带 Scene 或部署配置。

## 带 tiangz.project.json 的入门工程

在工程根目录依次运行 `npm run setup`、`npm run host-build`、`npm run build`、`npm run smoke`。计数器的 Increment 会实际调用 Rust 加法；smoke 验证真实请求后停止自己的测试进程。`npm run start` 启动已构建程序。

`npm run check` 检查生成物、TS 与 Rust 编译；首次 Cargo 构建可能较慢。`npm run doctor` 会报告缺少或过期的组合二进制，不能回退普通宿主。

Rust、Native 接口或 Model 改动必须停止自己的进程，重新 setup / host-build / build，再启动。当前 `npm run dev` 自动监听入口不支持 Native 工程，不能用 Hotfix-only 更新 Rust。普通 TS 工程流程不变。
