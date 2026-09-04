/** Unit表现的逻辑受众；默认仍是AOI，玩家私有状态必须显式选择Self。 / Logical audience for Unit presentations; AOI remains the default while player-private state must explicitly select Self. */
export const UnitPresentationAudience = {
  Aoi: 1,
  Self: 2,
} as const;

export type UnitPresentationAudienceValue =
  (typeof UnitPresentationAudience)[keyof typeof UnitPresentationAudience];

/**
 * Unit发出的协议中立表现；游戏适配器决定这些语义事件如何映射到客户端协议。
 * Protocol-neutral presentation emitted by a Unit; game adapters decide how these semantic events map to their client protocol.
 */
export const UnitPresentationType = {
  Say: 1,
  Emote: 2,
  /** 与一次性表情不同的持久动画状态。 / Persistent animation state, distinct from a one-shot emote. */
  EmoteState: 3,
  /** 运行时外观/模型替换，模型标识由文本承载。 / Runtime appearance/model replacement; the model identifier is carried in text. */
  Model: 4,
  /** 外置游戏模块定义的适配器表现；text必须使用模块命名空间键，Core不解释其负载。 / Adapter presentation defined by an external game module; text must be a module-namespaced key and Core does not interpret its payload. */
  Extension: 5,
} as const;

export type UnitPresentationTypeValue =
  (typeof UnitPresentationType)[keyof typeof UnitPresentationType];

export interface UnitPresentation {
  readonly type: UnitPresentationTypeValue;
  /** 缺省为AOI；Self只允许PlayerUnit作为source。 / Defaults to AOI; Self requires a PlayerUnit source. */
  readonly audience?: UnitPresentationAudienceValue;
  /** 可选语义/动画编号；说话使用零。 / Optional semantic or animation identifier; speech uses zero. */
  readonly presentationId: number;
  /** 可选的目标受众成员或交互对象。 / Optional targeted audience member or interaction subject. */
  readonly targetUnitId: number;
  readonly text: string;
}
