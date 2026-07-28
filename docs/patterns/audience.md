# 可见范围

## 规则卡

| 规则ID | 受众 |
|---|---|
| `audience.self` | 玩家私有状态，只发送给拥有者连接 |
| `audience.party` | 只向符合业务条件的队伍成员发送摘要 |
| `audience.aoi` | 地图外观或战斗事实，发送给当前AOI观察者 |
| `audience.global` | 全服事件，必须经过专门广播或订阅边界 |

可见范围由每次业务变化决定，不由Entity类型自动决定。Buff是ChildEntity但通常对AOI可见；Quest也是ChildEntity但默认只对本人可见，只有共享任务摘要对附近队友可见。

进入AOI时发送当前观察者有权看到的Unit整体Snapshot。离开AOI时移除Unit，不逐个删除Unit下面的Buff或共享任务摘要。

禁止把“可能有人需要看到”实现为全地图广播后由客户端过滤。业务层先产生明确Audience，AOI、Party、Guild等目录再解析具体连接。
