import type {
  Actor,
  Scene,
} from "./entities";
import type {
  ActorContext,
  SceneContext,
} from "./contexts";

export type SceneId = string;
export type SceneType = string;
export type EntityId = string | number;
export type InstanceId = number;
export type ActorId = EntityId;
export type MailboxType = "ordered" | "unordered";

export interface SceneRef {
  processId: string;
  sceneId: SceneId;
  sceneType: SceneType;
}

export interface ActorRef extends SceneRef {
  actorId: ActorId;
  instanceId: InstanceId;
}

export interface SceneOptions {
  sceneType: SceneType;
  mailbox?: MailboxType;
}

export interface ActorOptions {
  mailbox?: MailboxType;
}

export type SceneCtor<T extends Scene = Scene> = new (ctx: SceneContext) => T;
export type ActorCtor<T extends Actor<any[]> = Actor<any[]>> = new (
  ctx: ActorContext,
) => T;
export type ActorAwakeArgs<T extends Actor<any[]>> =
  T extends Actor<infer TAwakeArgs> ? TAwakeArgs : never;
