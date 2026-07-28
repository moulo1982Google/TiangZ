# 子 Entity 微基准

测试 Component 所有权与 EntityRoot 双索引下，非 Actor 子 Entity 的创建、O(1) 查找、稳定快照遍历、级联销毁和 V8 Heap 增量。

```powershell
npm run perf:child-entity -- --children 100000 --lookups 1000000
```

该基准不包含 Native 数据、Timer、AOI、protobuf 或网络。它只衡量框架对象语义成本，不能直接推导整服容量。Buff只在创建、删除和Unit进入AOI时同步；Tick产生的Numeric、Move等变化由各领域自己的同步机制处理，禁止扫描EntityRoot收集Buff。
