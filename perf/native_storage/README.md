# Native数据布局基准

这个基准在实现Rust AOI之前，单独比较三种权威数据布局：

1. 当前通用Handle Arena。
2. UnitPool与ItemPool类型分池。
3. UnitHotPool与UnitColdPool冷热分离。

三档使用相同Unit/Item数量和相同Unit热更新逻辑，checksum必须一致。计时区不包含AOI、网络、protobuf、V8或业务Handler，因此只能用于决定Rust实体Store布局，不能作为完整服务器容量。

```powershell
npm run perf:native-storage
```

可调整规模：

```powershell
npm run perf:native-storage -- --units 100000 --items-per-unit 10 --iterations 300 --rounds 7
```

结果写入：

- `perf/results/native_storage_latest.json`
- `perf/results/native_storage_latest.md`

`.native`字段使用`@hot`或`@cold`后，codegen会额外生成对应Entity的`HotData`、`ColdData`和`SplitData`候选结构。旧`XxxData`和TS Handle API仍然保留，基准本身不会切换正式运行时Store。
