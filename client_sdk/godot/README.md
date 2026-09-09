# Godot SDK 共享运行代码

`proto_reader.gd` 是 Proto 读取器的唯一实现源码。`tools/codegen_godot_client_sdk.mjs` 将它嵌入每个生成协议类的局部 `ProtoReader`，宿主和模块使用同一实现。消费方只需复制生成协议 `.gd`，不依赖示例目录、全局读取器类或编辑器缓存。

修改源码后运行 `npm run codegen`；禁止修改生成副本。设置 `GODOT_BIN` 后运行 `node tools/module_protocol_codegen_self_test.mjs`，会验证无示例文件的干净 Godot 工程，以及旧示例读取器兼容入口。读取器只负责编解码辅助，不实现网络连接、登录或游戏状态。
