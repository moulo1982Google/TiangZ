# KCP 上游说明

本目录使用 KCP 官方 C 实现的稳定 v1 分支，不使用第三方 Rust 重写。

- 上游仓库：`https://github.com/skywind3000/kcp`
- 固定提交：`8004f7eba5d1bf33f0691eef5f887f2cd3140cb5`
- 许可证：MIT，见 `LICENSE`
- `ikcp.c` SHA-256：`B476F4AE41B555F28E819F3A6F34B7E2307C93E17875B4864A8F5FC217F67F60`
- `ikcp.h` SHA-256：`F04F978A0893A8209D7B82095D19C38CEFCF8F30BC932A85BB7FA53B33F9E76C`

Cargo feature `kcp` 启用时，根目录 `build.rs` 使用 `cc` 将 `ikcp.c` 静态编译进 Runtime，不依赖系统安装的 `kcp.so`。

框架适配代码不写入本目录。官方 v1 未公开的 `rx_minrto` 设置接口放在 `src/native/kcp_shim.c`，从而保持这里的上游文件及其哈希不变。
