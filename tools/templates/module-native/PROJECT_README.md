# __MODULE_ID__ Rust 扩展入门工程

这是带 Rust 壳的 TS 教学工程，不是 SLG。计数器请求沿 TS Scene / Handler 进入，通过生成接口调用 Rust 加法。

## 第一次跑通

先安装宿主开发依赖与 Cargo/rustfmt，然后在本目录执行：

```powershell
npm run setup
npm run host-build
npm run build
npm run smoke
```

首次 Rust 编译可能较慢。`doctor` 只读检查环境，首次提示缺少组合宿主时执行 `host-build`。`check` 检查生成物、TS 类型并执行 Cargo check，会写构建缓存但不修复源码。

`smoke` 启动自己的进程，发送两次真实请求，预期返回 1、2，再优雅停止；不会停止占用端口的其他进程。端口可在 `configs/local/counter.json` 修改。

## 看代码

先看 [模块结构](modules/starter/README.md)，再看 [Rust 手写与生成边界](modules/starter/RUST.md)。`npm run inspect` 提供 TS 结构导航。

手写入口是模块内 `src/model`、`src/hotfix`、`native/Example.native`、`rust/src/native_data.rs`；所有 `generated` 目录由正式工具生成，不手改。`CounterComponentSystem.Increment()` 调用 `NativeExample.Add()`，最终进入 Rust `op_native_add()`。

## 修改与启动

`npm run start` 启动本工程已构建的组合程序，输入 shutdown 后回车停止。`npm run request` 向已运行的本机教学服务发送一次递增请求，会修改临时计数。

当前不支持 `npm run dev` 自动监听 Native 工程。修改 Rust / Native / Model 后停止自己的进程，重新 setup → host-build → build，再 start。Rust 不能通过 Hotfix-only 更新；不匹配的组合二进制会被拒绝，不回退普通宿主。

修改模块协议后显式运行 `npm run protocol-update`，再重新构建，不手写 opcode 或修改协议锁。

本模板只绑定本机回环地址，没有生产鉴权、登录、限流或持久化，不能直接公开到互联网。创建和构建不会操作数据库。
