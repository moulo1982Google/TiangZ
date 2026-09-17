(function () {
  "use strict";

  // This plugin deliberately keeps a small, dependency-free copy of the
  // TiangZ design knowledge so the .cindy package is portable by itself.
  // All tools are read-only: they do not access the network or edit files.
  var DESIGN_RULES = [
    rule("ownership.single-owner", "唯一所有者", "每个运行时对象只有一个直接所有者，集合增删经过所有者Component。", "docs/patterns/ownership-and-entity.md"),
    rule("entity.actor-target", "Actor消息目标", "只有需要mailbox和网络寻址的Scene、Session、Unit成为Actor目标。", "docs/patterns/ownership-and-entity.md"),
    rule("entity.local-child", "本地子Entity", "有稳定身份和独立生命周期、但不接收网络消息的对象使用ChildEntity。", "docs/patterns/ownership-and-entity.md"),
    rule("entity.value-state", "值状态", "没有独立身份的数据使用字段、Map、数组、Set或Numeric。", "docs/patterns/ownership-and-entity.md"),
    rule("audience.self", "本人受众", "玩家私有状态只发送给拥有者连接。", "docs/patterns/audience.md"),
    rule("audience.party", "队伍受众", "只向符合业务条件的队伍成员发送必要摘要。", "docs/patterns/audience.md"),
    rule("audience.aoi", "AOI受众", "地图外观或战斗事实发送给当前AOI观察者。", "docs/patterns/audience.md"),
    rule("audience.global", "全局受众", "全服事件经过专门广播或订阅边界。", "docs/patterns/audience.md"),
    rule("sync.snapshot", "全量快照", "登录、重连、进入AOI时发送观察者有权看到的完整当前状态。", "docs/patterns/state-replication.md"),
    rule("sync.latest", "可覆盖状态", "连续变化只需最终值时使用Latest/Delta并在帧尾合并。", "docs/patterns/state-replication.md"),
    rule("sync.event", "不可覆盖事件", "每次发生都不可丢时使用Event立即可靠排队。", "docs/patterns/state-replication.md"),
    rule("sync.none", "无网络同步", "纯服务端过程不产生网络同步，结果由被修改领域自行同步。", "docs/patterns/state-replication.md"),
    rule("lifecycle.owner-cascade", "所有权级联", "所有者销毁时自动销毁子Entity、组件、Timer和Native handle。", "docs/patterns/lifecycle-and-persistence.md"),
    rule("lifecycle.active-instance", "活动实例", "只为当前存在且有行为的实例创建ChildEntity。", "docs/patterns/lifecycle-and-persistence.md"),
    rule("persistence.record", "持久化记录", "数据库记录与运行时Entity、协议Snapshot使用不同类型。", "docs/patterns/lifecycle-and-persistence.md"),
    rule("persistence.stable-id", "稳定持久化身份", "持久化业务ID和时间戳，不保存InstanceId或TimerId。", "docs/patterns/lifecycle-and-persistence.md"),
    rule("execution.update", "固定帧更新", "每个固定逻辑帧必须执行的连续逻辑使用Update。", "docs/patterns/timer-update-and-action.md"),
    rule("execution.timer", "稀疏Timer", "游戏业务禁止await时间（含短/零延迟、原生定时器和Promise绕过）；使用所有者方法名Timer，持久化任务与截止时间，恢复不重复扣费。DB/RPC结果等待仍允许。", "docs/patterns/timer-update-and-action.md"),
    rule("module.ownership", "模块归属", "TiangZ是宿主；SLG/MMORPG业务在Examples或外置模块。Model持有状态，Hotfix只放行为，Handler薄适配；不将业务塞回Core。", "docs/ai/skill-development-contract.md"),
    rule("execution.pump-vs-update", "运行循环不是模拟帧", "按实际注册代码区分RPC、Timer、固定Update与出站队列；SLG不因框架存在帧尾队列就已经具备状态广播。", "docs/ai/skill-development-contract.md"),
    rule("protocol.inner-identity", "内外协议身份", "C协议不能用于Inner RPC，字段相同也需生成S descriptor；不关闭访问校验、不手改协议锁和SDK。", "docs/ai/business-development-manual.md"),
    rule("persistence.no-fallback", "数据库故障不降级", "IsHostDbProxyAvailable仅表示宿主桥存在，不表示进程配置或连接就绪；配置数据库后故障不可回退内存或重置资产。", "docs/ai/business-development-manual.md"),
    rule("persistence.unknown-result", "结果未知重试", "丢ACK保留原操作号与完整事务（含随机结果）重试；多记录一致性使用事务，批量保存不等于原子成功。", "docs/ai/skill-development-contract.md"),
    rule("hotfix.atomic-config", "原子发布", "当前保持单Hotfix包与配置进程内原子切换，沿用帧间切换和主动暂停入口、默认3000ms窗口；超时恢复旧版。不是全Pod同时切换，也不保证任何30秒RPC都不超时；Model/协议/Native变化须重建重启。", "docs/design/typescript-hot-reload.md"),
    rule("sync.durable-fact", "事实与持久保证", "latest只覆盖可替代当前状态，抽卡/扣费/结算事实不能静默覆盖；可靠网络队列不等于持久exactly-once。", "docs/patterns/state-replication.md"),
    rule("validation.evidence", "证据与授权", "分别报告单测、假存储、真实RPC、真实DB恢复、UI和长稳；故障原因及复测留档，Rust重建前旧结果不能算给新版。故障/清库/长稳只在用户授权范围执行。", "docs/ai/business-development-manual.md"),
    rule("execution.coalesced-timer", "合并Timer", "同一所有者下大量定时对象使用最近到期Timer统一调度。", "docs/patterns/timer-update-and-action.md"),
    rule("execution.action-delegation", "Action领域委托", "Action修改哪个领域，就调用哪个领域能力并复用其同步机制。", "docs/patterns/timer-update-and-action.md"),
    rule("data.ts-default", "TypeScript优先", "普通业务状态和行为默认留在Model/Hotfix TypeScript。", "docs/patterns/data-placement.md"),
    rule("data.native-measure-first", "Native先测量", "只有实测收益支持时才把高频权威数据下沉Rust。", "docs/patterns/data-placement.md"),
    rule("data.coarse-op", "粗粒度Native操作", "TS与Rust之间使用粗粒度批处理，避免Update中逐对象逐字段往返。", "docs/patterns/data-placement.md"),
    rule("data.generated-boundary", "生成边界", "Native Ref、Rust Pool和FastOp由codegen生成，业务不手写桥代码。", "docs/patterns/data-placement.md")
  ];

  var RULES_BY_ID = Object.create(null);
  DESIGN_RULES.forEach(function (item) { RULES_BY_ID[item.id] = item; });

  var ARCHETYPE_KEYWORDS = {
    item: ["item", "道具", "背包", "装备"],
    buff: ["buff", "状态效果", "光环"],
    quest: ["quest", "任务", "主线", "支线"],
    achievement: ["achievement", "成就"],
    numeric: ["numeric", "数值", "属性", "血量"]
  };

  var ENVIRONMENT_REQUIREMENTS = {
    summary: "2026-09-17工作区基线：TiangZ 0.6.0-alpha.0，Node.js 24.x，Rust按rust-toolchain.toml（当前1.97.1）。版本不是在线探测结果，换分支先核对清单。游戏示例已拆到TiangZ-Examples；Docker仅用于需要的本地数据库/容器验证，不是技能运行前提。",
    repositories: [
      {
        name: "TiangZ",
        url: "https://github.com/moulo1982Google/TiangZ.git",
        branch: "main",
        workingVersion: "0.6.0-alpha.0",
        stableBaseline: "0.3.10"
      },
      {
        name: "TiangZ Native Language",
        url: "https://github.com/moulo1982Google/tiangz-native-language.git",
        note: "以当前检出的package.json与扩展清单为准，Core与VS Code扩展可能分开记版本；从同一兼容源码构建，不声明未核验的最新发布版本。"
      },
      {
        name: "TiangZ DBProxy",
        url: "https://github.com/moulo1982Google/TiangZ-DBProxy.git",
        branch: "main",
        workingPackageVersion: "0.6.0",
        note: "持久化开发建议与 TiangZ main 配套使用；不要把旧 release tag 当作当前工作分支。"
      }
    ],
    prerequisites: {
      node: "TiangZ 主工程要求 Node.js 24.x；其他工具以各自 engines 为准",
      rust: "Rust 1.97.1；TiangZ 仓库的 rust-toolchain.toml 会固定该 toolchain，并要求 rustfmt/clippy",
      vscode: "VS Code 1.91 或更高版本（安装 Native Language 扩展时）",
      git: "用于下载 TiangZ、Native Language 和 DBProxy 源码",
      docker: "仅在启动本地 PostgreSQL/Redis/Prometheus/Grafana 或执行真实持久化/故障演练时需要 Docker Desktop"
    },
    dockerDecision: {
      designAssistant: false,
      nativeLanguageEditorAndCodegen: false,
      mainTiangzMemoryBackend: false,
      dbproxyPersistentLocalStack: true,
      dbproxyStorageAndFaultTests: true,
      explanation: "只做设计、语言解析、代码生成或不依赖外部数据库的 MemoryBackend 开发时可以不装 Docker。要验证 DBProxy 的 PostgreSQL、Redis、AOF、缓存修复、Outbox 或重启恢复时需要 Docker。"
    },
    setupCommands: {
      nativeLanguage: [
        "git clone https://github.com/moulo1982Google/tiangz-native-language.git",
        "cd tiangz-native-language",
        "npm install",
        "npm run check",
        "npm run package:extension"
      ],
      mainTiangzWithoutDocker: [
        "cd TiangZ",
        "npm install",
        "npm run build",
        "# 游戏启动改用TiangZ-Examples目标包README，主工程不再自带示例all-in-one配置"
      ],
      dbproxyWithDocker: [
        "cd TiangZ-DBProxy",
        "docker compose --env-file deploy/local/.env -f deploy/local/docker-compose.yml up -d",
        "powershell -ExecutionPolicy Bypass -File tools/run_local.ps1"
      ]
    },
    cautions: [
      "不要为了安装 Native Language 扩展而先安装 Docker。",
      "DBProxy 的 down -v 会删除本地开发数据卷，必须由用户明确确认后才能执行。",
      "本地默认数据库、Redis 凭据和 DBProxy token 只适用于回环开发，不能复制到生产环境。",
      "版本信息来自仓库当前开发状态；正式发布前应重新检查 tag、CHANGELOG 和 toolchain 文件。"
    ],
    sourceEvidence: [
      "TiangZ/README.md",
      "TiangZ/rust-toolchain.toml",
      "tiangz-native-language/README.md",
      "tiangz-native-language/package.json",
      "tiangz-native-language/CHANGELOG.md",
      "TiangZ-DBProxy/deploy/local/README.md"
    ]
  };

  function rule(id, title, recommendation, document) {
    return { id: id, title: title, recommendation: recommendation, document: document };
  }

  function inferSystemArchetype(text) {
    var normalized = String(text || "").toLocaleLowerCase();
    var names = Object.keys(ARCHETYPE_KEYWORDS);
    for (var i = 0; i < names.length; i += 1) {
      var archetype = names[i];
      var keywords = ARCHETYPE_KEYWORDS[archetype];
      for (var j = 0; j < keywords.length; j += 1) {
        if (normalized.indexOf(keywords[j]) >= 0) return archetype;
      }
    }
    return "custom";
  }

  function recommendSystemDesign(request) {
    switch (request.archetype) {
      case "item": return itemRecommendation(request.name);
      case "buff": return buffRecommendation(request.name);
      case "quest": return questRecommendation(request.name);
      case "achievement": return achievementRecommendation(request.name);
      case "numeric": return numericRecommendation(request.name);
      case "custom": return customRecommendation(request);
      default: throw new Error("archetype 必须是 item、buff、quest、achievement、numeric 或 custom");
    }
  }

  function formatDesignRecommendation(result) {
    var lines = ["# " + result.title, "", result.summary, "", "## 核心决定", ""];
    result.decisions.forEach(function (item) {
      lines.push("- **" + item.label + "**：" + item.value + "。" + item.reason);
    });
    lines.push("", "## 生命周期", "");
    result.lifecycle.forEach(function (item, index) { lines.push((index + 1) + ". " + item); });
    lines.push("", "## 同步与受众", "");
    result.synchronization.forEach(function (item) { lines.push("- " + item); });
    lines.push("", "## 推荐落点", "");
    result.implementation.forEach(function (item) { lines.push("- " + item); });
    lines.push("", "## 避免", "");
    result.avoid.forEach(function (item) { lines.push("- " + item); });
    lines.push("", "## 依据", "");
    result.ruleIds.forEach(function (id) {
      var item = RULES_BY_ID[id];
      if (item) lines.push("- `" + item.id + "`：" + item.recommendation);
    });
    lines.push("", "相关文档（相对 TiangZ 文档目录）：");
    result.documents.forEach(function (document) { lines.push("- " + document); });
    return lines.join("\n");
  }

  function itemRecommendation(name) {
    return recommendation("item", name || "Item系统", "道具是玩家拥有的独立实例；集合变化由ItemComponent协调，单件道具规则留在Item。", [
      decision("所有者", "PlayerUnit.ItemComponent", "背包是玩家聚合边界。"),
      decision("运行时对象", "Item ChildEntity", "道具有稳定ItemId和独立创建、销毁、强化等生命周期。"),
      decision("默认受众", "Self", "库存默认是玩家私有数据。"),
      decision("同步", "Snapshot + Event", "登录发送快照，使用、获得、删除等事实不可覆盖。"),
      decision("数据位置", "先TypeScript；有实测批处理收益时使用Native", "ChildEntity不自动意味着Rust下沉。")
    ], [
      "创建或加载时由ItemComponent.AddChild创建Item。",
      "使用、拆分、合并和转移由ItemComponent统一校验。",
      "删除时RemoveChild，Core级联释放Timer与Native handle。"
    ], [
      "登录或重连向本人发送背包Snapshot。",
      "获得、消耗、删除和交易结果使用不可覆盖Event。",
      "装备外观若对他人可见，由外观系统向AOI广播，不公开完整背包。"
    ], [
      "Model定义Item、ItemComponent和稳定字段。",
      "Hotfix的ItemSystem实现单件规则，ItemComponentSystem实现集合规则。",
      "Handler只做协议适配并调用ItemComponent领域方法。"
    ], [
      "公开可变Map或NativeItemRef给Handler。",
      "把每件道具做成Actor或网络消息目标。",
      "因为当前Item样例使用Native就让所有道具系统强制下沉Rust。"
    ], ["ownership.single-owner", "entity.local-child", "audience.self", "sync.snapshot", "sync.event", "data.native-measure-first"]);
  }

  function buffRecommendation(name) {
    return recommendation("buff", name || "Buff系统", "Buff是Unit拥有的本地生命周期实例；创建和删除广播，Tick只执行Action。", [
      decision("所有者", "Unit.BuffComponent", "玩家、怪物和NPC使用同一Buff组合能力。"),
      decision("运行时对象", "Buff ChildEntity", "每个Buff有来源、层数、起止时间和独立生命周期，但不需要mailbox。"),
      decision("默认受众", "AOI", "Buff图标和可见战斗状态通常需要周围观察者知道。"),
      decision("同步", "BuffAdded/BuffRemoved Event + Unit Snapshot", "Buff本身不是每Tick变化的复制状态。"),
      decision("Tick", "执行Action，不广播Buff", "Numeric、Move等结果由对应领域已有机制同步。")
    ], [
      "AddChild创建Buff并向当前AOI发送BuffAdded。",
      "Timer到点调用Buff Action；大量Buff由BuffComponent合并调度。",
      "到期、驱散或覆盖时RemoveChild并发送BuffRemoved。"
    ], [
      "观察者进入AOI时，Buff列表随Unit整体Snapshot发送。",
      "观察者离开AOI时只删除Unit，不逐个发送BuffRemoved。",
      "Buff Tick不产生Buff dirty或剩余时间Delta。"
    ], [
      "Model定义Buff、BuffComponent和持久化字段。",
      "Hotfix实现Buff Action与BuffComponent集合规则。",
      "客户端根据开始/结束时间自行显示剩余时间。"
    ], [
      "每Tick广播Buff剩余时间。",
      "扫描EntityRoot收集Buff。",
      "因为Buff对AOI可见就给每个Buff创建mailbox。"
    ], ["ownership.single-owner", "entity.local-child", "audience.aoi", "sync.event", "sync.snapshot", "sync.none", "execution.action-delegation", "execution.coalesced-timer"]);
  }

  function questRecommendation(name) {
    return recommendation("quest", name || "Quest系统", "QuestComponent只持有进行中Quest；完成后删除实例并记录稳定配置ID。", [
      decision("所有者", "PlayerUnit.QuestComponent", "任务状态属于玩家聚合。"),
      decision("运行时对象", "Active Quest ChildEntity", "只有进行中的任务具有进度和生命周期。"),
      decision("完成记录", "Set/Bitmap<QuestConfigId>", "历史完成事实不需要保留运行时Entity。"),
      decision("默认受众", "Self；共享任务可选Party", "任务默认私有，队友只需要共享摘要。"),
      decision("同步", "本人进度通知 + 登录Snapshot + Party摘要", "任务变化低频，不需要通用dirty mask。")
    ], [
      "QuestComponent初始可以没有Quest子Entity。",
      "接受任务时AddChild创建活动Quest。",
      "完成时统一结算奖励、记录配置ID、RemoveChild并发送完成通知。",
      "放弃任务只RemoveChild，不写入完成集合。"
    ], [
      "进度变化默认只通知任务拥有者。",
      "共享任务只向附近Party成员发送必要摘要。",
      "队友进入AOI时，共享摘要可随Unit整体Snapshot发送；普通观察者不包含Quest。",
      "离开AOI时只删除Unit。"
    ], [
      "不可重复任务可用配置ID作为Quest Id。",
      "允许并存的重复任务使用独立实例ID，并单独保存configId。",
      "登录或重连向本人发送活动任务和已完成摘要。"
    ], [
      "为每个历史已完成任务保留空Quest Entity。",
      "把完整Quest广播给地图AOI或所有队友。",
      "在Handler中分别修改奖励、完成集合和活动Quest，破坏领域原子性。"
    ], ["ownership.single-owner", "entity.local-child", "lifecycle.active-instance", "persistence.stable-id", "audience.self", "audience.party", "sync.snapshot", "sync.event"]);
  }

  function achievementRecommendation(name) {
    return recommendation("achievement", name || "Achievement系统", "AchievementComponent拥有活动进度；是否创建ChildEntity取决于是否存在独立实例生命周期。", [
      decision("所有者", "PlayerUnit.AchievementComponent", "成就进度是玩家私有状态。"),
      decision("对象形态", "默认Map状态；复杂活动成就使用ChildEntity", "大量静态配置进度不应无条件创建对象。"),
      decision("默认受众", "Self", "他人通常只看展示栏摘要。"),
      decision("同步", "登录Snapshot + 进度/完成通知", "完成事实不可丢，普通进度可按业务节流。")
    ], [
      "首次产生进度时创建状态或活动实例。",
      "完成时记录配置ID和完成时间，并清理不再需要的活动实例。",
      "展示栏从已完成记录选择摘要，不泄漏完整进度。"
    ], [
      "本人收到进度和完成通知。",
      "公开展示只同步选中的成就摘要。"
    ], [
      "先使用TypeScript Map/Set；只有独立计时、重复实例等需求时使用ChildEntity。",
      "完成历史保存稳定配置ID和时间戳。"
    ], [
      "为配置表中的每个成就预创建Entity。",
      "向AOI广播玩家完整成就集合。"
    ], ["ownership.single-owner", "entity.value-state", "entity.local-child", "audience.self", "sync.snapshot", "sync.event", "data.ts-default"]);
  }

  function numericRecommendation(name) {
    return recommendation("numeric", name || "Numeric系统", "Numeric是Unit上的整数键值状态，不为每个数值创建Entity。", [
      decision("所有者", "Unit.NumericComponent", "属性共同组成Unit权威数值状态。"),
      decision("对象形态", "NumericType -> number字典", "数值没有独立身份和生命周期。"),
      decision("同步", "dirty latest + FrameFlush", "同帧多次修改只需要最终值。"),
      decision("受众", "由Numeric类型决定Self或AOI", "私有货币与公开HP不能使用同一固定受众。")
    ], [
      "Unit创建时挂载NumericComponent。",
      "领域Action通过Numeric API修改值并自动置dirty。",
      "帧尾按NumericType合并并在成功排队后Ack。"
    ], [
      "登录和进入视野发送观察者有权看到的Snapshot。",
      "变化使用latest Delta，不为每次加减发送Event。"
    ], [
      "使用稳定整数NumericType。",
      "公开与私有Numeric在生成Audience时过滤。"
    ], [
      "每个属性创建一个Entity。",
      "同帧每次加减都立即广播。"
    ], ["entity.value-state", "sync.latest", "sync.snapshot", "data.native-measure-first"]);
  }

  function customRecommendation(request) {
    var owner = request.owner || "player";
    var identity = request.independentIdentity === true;
    var lifecycle = request.independentLifecycle === undefined ? identity : request.independentLifecycle === true;
    var networkTarget = request.networkTarget === true;
    var audiences = unique(request.audiences && request.audiences.length ? request.audiences : ["self"]);
    var semantics = request.changeSemantics || "event";
    var frequency = request.changeFrequency || "low";
    var rules = ["ownership.single-owner", "data.ts-default"];
    var objectShape = networkTarget
      ? "Scene、Session或Unit中的一种明确Actor目标"
      : identity && lifecycle
        ? "所属Component下的ChildEntity"
        : "所属Component内部字段、Map、数组或Set";
    rules.push(networkTarget ? "entity.actor-target" : identity && lifecycle ? "entity.local-child" : "entity.value-state");
    audiences.forEach(function (audience) { if (audience !== "none") rules.push("audience." + audience); });
    rules.push("sync." + semantics);
    return recommendation("custom", request.name || "自定义业务系统", "这是根据当前答案生成的初步设计；业务事实不明确时应先确认所有权和受众，再生成代码。", [
      decision("所有者", ownerLabel(owner), "所有状态变化必须从一个明确聚合边界进入。"),
      decision("对象形态", objectShape, networkTarget ? "该对象需要独立消息串行与寻址。" : identity && lifecycle ? "它有独立身份和生命周期但不需要网络路由。" : "它不需要额外Entity身份。"),
      decision("变化语义", semanticsLabel(semantics), "由连续变化能否覆盖决定。"),
      decision("频率", frequencyLabel(frequency), "频率用于决定是否帧尾合并和是否值得性能测量。"),
      decision("持久化", request.persistent === false ? "不持久化" : "保存稳定业务字段", "绝不保存InstanceId和TimerId。")
    ], [
      "由所有者创建和删除状态。",
      lifecycle ? "所有者销毁时级联清理对象、Timer和句柄。" : "状态随所属Component生命周期存在。",
      request.persistent === false ? "重启后从业务默认值重建。" : "加载持久化记录后重建运行时对象。"
    ], synchronizationFor(audiences, semantics), [
      "Model保存稳定类型、字段和所有权结构。",
      "Hotfix保存Handler、流程编排和领域方法。",
      frequency === "high" ? "先建立业务基准，再决定是否使用Native或Rust批处理。" : "默认留在TypeScript，不提前下沉Rust。"
    ], [
      "没有明确受众就广播给AOI或全服。",
      "仅因为对象有多个实例就给它创建mailbox。",
      "绕过所有者Component直接修改集合。"
    ], unique(rules));
  }

  function decision(label, value, reason) {
    return { label: label, value: value, reason: reason };
  }

  function recommendation(archetype, title, summary, decisions, lifecycle, synchronization, implementation, avoid, ruleIds) {
    var documents = unique(ruleIds.map(function (id) { return RULES_BY_ID[id] && RULES_BY_ID[id].document; }).filter(Boolean));
    return {
      version: 1,
      archetype: archetype,
      title: title,
      summary: summary,
      decisions: decisions,
      lifecycle: lifecycle,
      synchronization: synchronization,
      implementation: implementation,
      avoid: avoid,
      ruleIds: unique(ruleIds),
      documents: documents
    };
  }

  function ownerLabel(owner) {
    return ({
      player: "PlayerUnit上的业务Component",
      map: "MapScene上的业务Component",
      scene: "EntryScene上的业务Component",
      session: "Session上的连接Component"
    })[owner] || "明确的业务聚合Component";
  }

  function semanticsLabel(value) {
    return ({ none: "不产生网络同步", latest: "可覆盖Latest/Delta", event: "不可覆盖Event" })[value] || "不可覆盖Event";
  }

  function frequencyLabel(value) {
    return ({ low: "低频，直接领域通知", medium: "中频，按语义决定合并", high: "高频，必须建立基准并批处理" })[value] || "低频，直接领域通知";
  }

  function synchronizationFor(audiences, semantics) {
    if (semantics === "none" || audiences.indexOf("none") >= 0) {
      return ["该过程不直接产生网络同步；由被修改领域自行决定。"];
    }
    var labels = { self: "本人", party: "队伍", aoi: "AOI", global: "全局", none: "无" };
    var audienceText = audiences.map(function (item) { return labels[item] || item; }).join("、");
    return [
      "变化发送给：" + audienceText + "。",
      semantics === "latest" ? "同一key连续变化在帧尾合并，只发送最终状态。" : "每次变化都是不可覆盖事实，使用Event可靠排队。",
      "登录、重连或新观察关系建立时，按权限提供Snapshot。"
    ];
  }

  function unique(values) {
    return values.filter(function (value, index) { return values.indexOf(value) === index; });
  }

  function objectArgs(msg) {
    var args = msg && (msg.args || msg.arguments || {});
    if (typeof args === "string") {
      try { args = JSON.parse(args); } catch (_) { throw new Error("工具参数不是有效 JSON"); }
    }
    if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("工具参数必须是对象");
    return args;
  }

  function requiredText(args, key) {
    if (typeof args[key] !== "string" || !args[key].trim()) throw new Error(key + " 必须是非空字符串");
    return args[key].trim();
  }

  function validateRecommendationArgs(args) {
    var archetypes = ["item", "buff", "quest", "achievement", "numeric", "custom"];
    if (typeof args.archetype !== "string" || archetypes.indexOf(args.archetype) < 0) {
      throw new Error("archetype 必须是 item、buff、quest、achievement、numeric 或 custom");
    }
    if (args.owner !== undefined && ["player", "map", "scene", "session"].indexOf(args.owner) < 0) {
      throw new Error("owner 必须是 player、map、scene 或 session");
    }
    if (args.audiences !== undefined) {
      if (!Array.isArray(args.audiences)) throw new Error("audiences 必须是数组");
      var audienceValues = ["self", "party", "aoi", "global", "none"];
      args.audiences.forEach(function (item) {
        if (audienceValues.indexOf(item) < 0) throw new Error("audiences 包含未知受众：" + item);
      });
    }
    if (args.changeSemantics !== undefined && ["none", "latest", "event"].indexOf(args.changeSemantics) < 0) {
      throw new Error("changeSemantics 必须是 none、latest 或 event");
    }
    if (args.changeFrequency !== undefined && ["low", "medium", "high"].indexOf(args.changeFrequency) < 0) {
      throw new Error("changeFrequency 必须是 low、medium 或 high");
    }
    ["independentIdentity", "independentLifecycle", "networkTarget", "persistent"].forEach(function (key) {
      if (args[key] !== undefined && typeof args[key] !== "boolean") throw new Error(key + " 必须是布尔值");
    });
    return args;
  }

  function dispatch(tool, args) {
    if (tool === "list_design_rules") {
      return { count: DESIGN_RULES.length, rules: DESIGN_RULES };
    }
    if (tool === "get_environment_requirements") {
      return ENVIRONMENT_REQUIREMENTS;
    }
    if (tool === "infer_system_archetype") {
      var text = requiredText(args, "text");
      return { text: text, archetype: inferSystemArchetype(text) };
    }
    if (tool === "recommend_system_design") {
      var request = validateRecommendationArgs(args);
      var result = recommendSystemDesign(request);
      return { recommendation: result, markdown: formatDesignRecommendation(result) };
    }
    throw new Error("未知工具：" + tool);
  }

  cindy.onHostMessage(async function (msg) {
    if (!msg || msg.type !== "tool-call") return;
    try {
      var result = dispatch(msg.tool, objectArgs(msg));
      await cindy.send({ type: "tool-result", callId: msg.callId, ok: true, result: result });
    } catch (error) {
      await cindy.send({
        type: "tool-result",
        callId: msg.callId,
        ok: false,
        error: error && error.message ? error.message : String(error)
      });
    }
  });
})();
