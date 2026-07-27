import type { MaybePromise } from "../async";
import { Game, InitializeGameSingletons, monotonicNow } from "../runtime/Game";
import { ProcessHost } from "../runtime/host";
import { SingletonRegistry } from "../runtime/Singleton";
import { TimeSystem } from "../runtime/TimeSystem";
import { TimerSystem } from "../runtime/TimerSystem";
import { UpdateSystem } from "../runtime/UpdateSystem";
import { getEntrySceneCtor, listEntrySceneTypes } from "./registry";
import type {
  EntryScene,
  LocalSceneRouter,
  OutboundBatch,
  ProcessRuntimeConfig,
  SceneMetricsSnapshot,
  SceneUpdateResult,
} from "./types";
import { CoreLogger } from "../logging/Logger";

export interface ProcessUpdateResult {
  outbound: OutboundBatch[];
  metrics: SceneMetricsSnapshot[];
  game: GameMetricsSnapshot;
  pendingAsync: boolean;
}

export interface GameMetricsSnapshot {
  fixedUpdateMs: number;
  frameCount: number;
  skippedFixedUpdates: number;
  updateTargets: number;
  updateCalls: number;
  updateFailures: number;
  timers: number;
}

export class ProcessRuntime implements LocalSceneRouter {
  private readonly entryScenes: EntryScene[];
  private readonly scenesByName = new Map<string, EntryScene>();
  private readonly processHost: ProcessHost;
  private lifecycleState: "created" | "starting" | "ready" | "stopping" | "stopped" = "created";
  private stopPromise: Promise<void> | undefined;

  constructor(private readonly config: ProcessRuntimeConfig) {
    InitializeGameSingletons(config.process.game);
    this.processHost = new ProcessHost(config.process.name);
    this.entryScenes = [];
    try {
      for (const scene of config.scenes) {
        const ctor = getEntrySceneCtor(scene.sceneType);
        if (!ctor) {
          throw new Error(
            `unknown scene type: ${scene.sceneType}; registered: ${listEntrySceneTypes().join(", ")}`,
          );
        }
        const instance = new ctor({
          process: config.process,
          self: scene,
          knownScenes: config.knownScenes,
          tickMs: config.tickMs,
          processHost: this.processHost,
          localRouter: this,
        });
        this.processHost.attachScene(
          scene.name,
          scene.sceneType,
          instance,
          instance.__mailboxType(),
        );
        instance.__initializeRuntime();
        if (this.scenesByName.has(scene.name)) {
          throw new Error(`duplicate local scene: ${scene.name}`);
        }
        this.scenesByName.set(scene.name, instance);
        this.entryScenes.push(instance);
      }
    } catch (error) {
      try {
        this.processHost.Dispose();
      } catch (cleanupError) {
        CoreLogger.error("process constructor cleanup failed", { cleanupError });
      }
      try {
        SingletonRegistry.DestroyAll();
      } catch (cleanupError) {
        CoreLogger.error("singleton constructor cleanup failed", { cleanupError });
      }
      throw error;
    }
  }

  get StopTimeoutMs(): number {
    return this.config.process.lifecycle?.stopTimeoutMs ?? 10_000;
  }

  /** 仅在没有待处理帧和异步业务任务时开放 Hotfix 提交屏障。 / Opens the Hotfix commit barrier only when no queued frame or asynchronous business task remains. */
  get CanCommitHotfix(): boolean {
    return this.lifecycleState === "ready" &&
      this.entryScenes.every((scene) => scene.__canCommitHotfix());
  }

  /** 建立生命周期屏障：所有 Scene 都完成 start 后，任何 Scene 才能进入 ready。 / Creates a lifecycle barrier: every Scene starts before any Scene becomes ready. */
  async start(): Promise<string> {
    if (this.lifecycleState !== "created") {
      throw new Error(`process cannot start from ${this.lifecycleState}`);
    }
    this.lifecycleState = "starting";
    try {
      for (const scene of this.entryScenes) await scene.__startLifecycle();
      for (const scene of this.entryScenes) await scene.__readyLifecycle();
    } catch (error) {
      await this.stopAfterStartFailure();
      throw error;
    }
    this.lifecycleState = "ready";
    const started = this.entryScenes.map((scene) => scene.startupMessage()).join("\n");
    return `[process:${this.config.process.name}] one V8 started with ${this.entryScenes.length} scene(s)\n${started}`;
  }

  /** 进程只停机一次；并发调用者共享同一个完成结果与错误。 / Stops the process once; concurrent callers share the same completion and errors. */
  stop(): Promise<void> {
    this.stopPromise ??= this.stopRuntime();
    return this.stopPromise;
  }

  private async stopRuntime(): Promise<void> {
    if (this.lifecycleState === "stopped") return;
    this.lifecycleState = "stopping";
    const errors: unknown[] = [];
    for (const scene of [...this.entryScenes].reverse()) {
      try {
        await scene.__stopLifecycle();
      } catch (error) {
        errors.push(error);
        scene.logger.error("scene stop failed", { error });
      }
    }
    this.disposeRuntime(errors);
    this.lifecycleState = "stopped";
    if (errors.length > 0) {
      throw new AggregateError(errors, `process ${this.config.process.name} stop failed`);
    }
  }

  /** 将不可变宿主帧放入目标 Scene mailbox。 / Enqueues an immutable host frame into the addressed Scene mailbox. */
  pushHostFrame(sceneIndex: number, connectionId: number, frame: Uint8Array): void {
    this.sceneAt(sceneIndex).pushHostFrame(connectionId, frame);
  }

  /** 让断线通知排在该 Scene 已接收帧之后，避免越过先前消息。 / Orders a disconnect notification after frames already accepted for that Scene. */
  pushHostDisconnect(sceneIndex: number, connectionId: number): void {
    this.sceneAt(sceneIndex).pushHostDisconnect(connectionId);
  }

  /** 在本进程唯一 V8 线程内推进 Game.Update 和所有本地 Scene mailbox。 / Advances Game.Update and every local Scene mailbox inside this process's single V8 thread. */
  update(includeMetrics = true): MaybePromise<ProcessUpdateResult> {
    const startedAt: number[] = [];
    Game.Instance.Update(monotonicNow(), Date.now(), () => {
      for (const scene of this.entryScenes) startedAt.push(scene.__pumpMailbox(512));
    });
    return mergeResults(
      this.entryScenes.map((scene, index) =>
        scene.__completeUpdate(startedAt[index] ?? monotonicNow(), includeMetrics)
      ),
    );
  }

  hasLocalScene(name: string): boolean { return this.scenesByName.has(name); }

  /** 通过目标 mailbox 执行进程内 RPC，绝不绕过 mailbox 直接调用 Handler。 / Performs an in-process RPC through the target mailbox; it never shortcuts into the handler. */
  callLocalScene(sourceName: string, targetName: string, frame: Uint8Array): Promise<Uint8Array> {
    if (sourceName === targetName) {
      return Promise.reject(new Error(`ordered scene ${sourceName} cannot synchronously call itself`));
    }
    return this.sceneByName(targetName).dispatchLocalCall(frame);
  }

  /** 将进程内单向帧入队；后续 Handler 失败只记录日志，不阻塞发送方。 / Enqueues an in-process one-way frame and logs later handler failure without blocking the sender. */
  sendLocalScene(_sourceName: string, targetName: string, frame: Uint8Array): Promise<void> {
    const target = this.sceneByName(targetName);
    void target.dispatchLocalSend(frame).catch((error) => {
      CoreLogger.error("local one-way message failed", { targetScene: targetName, error });
    });
    return Promise.resolve();
  }

  private sceneAt(index: number): EntryScene {
    const scene = this.entryScenes[index];
    if (!scene) throw new Error(`unknown local scene index: ${index}`);
    return scene;
  }

  private sceneByName(name: string): EntryScene {
    const scene = this.scenesByName.get(name);
    if (!scene) throw new Error(`local scene not found: ${name}`);
    return scene;
  }

  private async stopAfterStartFailure(): Promise<void> {
    try {
      await this.stop();
    } catch (error) {
      CoreLogger.error("cleanup after process start failure failed", { error });
    }
  }

  private disposeRuntime(errors: unknown[]): void {
    try {
      this.processHost.Dispose();
    } catch (error) {
      errors.push(error);
      CoreLogger.error("process host destroy failed", { error });
    }
    for (const scene of [...this.entryScenes].reverse()) {
      try {
        scene.__disposeRuntime();
      } catch (error) {
        errors.push(error);
        scene.logger.error("entry scene destroy failed", { error });
      }
    }
    try {
      SingletonRegistry.DestroyAll();
    } catch (error) {
      errors.push(error);
      CoreLogger.error("singleton destroy failed", { error });
    }
  }
}

function mergeResults(
  results: SceneUpdateResult[],
): ProcessUpdateResult {
  const game = gameMetricsSnapshot();
  if (results.length === 1) {
    return {
      outbound: results[0].outbound,
      metrics: results[0].metrics ? [results[0].metrics] : [],
      game,
      pendingAsync: results[0].pendingAsync,
    };
  }
  const outbound: OutboundBatch[] = [];
  const metrics: SceneMetricsSnapshot[] = [];
  let pendingAsync = false;
  for (const result of results) {
    pendingAsync ||= result.pendingAsync;
    if (result.metrics) metrics.push(result.metrics);
    for (const batch of result.outbound) {
      outbound.push(batch);
    }
  }
  return {
    outbound,
    metrics,
    game,
    pendingAsync,
  };
}

function gameMetricsSnapshot(): GameMetricsSnapshot {
  return {
    fixedUpdateMs: Game.Instance.FixedUpdateMs,
    frameCount: TimeSystem.Instance.FrameCount,
    skippedFixedUpdates: Game.Instance.SkippedFixedUpdates,
    updateTargets: UpdateSystem.Instance.Count,
    updateCalls: UpdateSystem.Instance.UpdateCount,
    updateFailures: UpdateSystem.Instance.FailedCount,
    timers: TimerSystem.Instance.Count,
  };
}
