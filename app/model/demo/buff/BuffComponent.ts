import { Component, component, lifecycle, transferable } from "../../../core/public";
import type { ActionDefinition } from "../action/ActionType";

/**
 * 运行时覆盖Buff配置的可选参数。没有覆盖时，BuffSystem读取BuffConfig。
 * 这是业务扩展点，不允许把不可序列化的闭包塞进来。
 *
 * Optional runtime overrides for BuffConfig. BuffSystem reads the table when
 * a field is absent. This is a business extension point; non-serializable
 * closures must never be placed here.
 */
export interface BuffAddOptions {
  readonly durationMs?: number;
  readonly tickIntervalMs?: number;
  readonly stacks?: number;
  readonly addAction?: ActionDefinition;
  readonly tickAction?: ActionDefinition;
  readonly removeAction?: ActionDefinition;
}

/**
 * 一个Unit只拥有一个BuffComponent，多个Buff通过ChildEntity挂载。
 * BuffComponent负责集合、传输和公开快照；单个Buff的Timer由Buff自身拥有。
 *
 * One Unit owns one BuffComponent, while individual Buffs are ChildEntities.
 * BuffComponent owns collection, transfer, and public snapshots; each Buff
 * owns its own timer.
 */
@component()
@transferable()
@lifecycle({ awake: true, destroy: true, deserialize: true })
export class BuffComponent extends Component {
}
