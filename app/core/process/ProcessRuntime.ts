import type { MaybePromise } from "../async";
import {
  Game,
  InitializeGameSingletons,
  ProcessHost,
  TimeSystem,
  TimerSystem,
  UpdateSystem,
  SingletonRegistry,
  monotonicNow,
} from "../runtime";
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
    this.entryScenes = config.scenes.map((scene) => {
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
      if (this.scenesByName.has(scene.name)) throw new Error(`duplicate local scene: ${scene.name}`);
      this.scenesByName.set(scene.name, instance);
      return instance;
    });
  }

  get StopTimeoutMs(): number {
    return this.config.process.lifecycle?.stopTimeoutMs ?? 10_000;
  }

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

  pushHostFrame(sceneIndex: number, connectionId: number, frame: Uint8Array): void {
    this.sceneAt(sceneIndex).pushHostFrame(connectionId, frame);
  }

  pushHostDisconnect(sceneIndex: number, connectionId: number): void {
    this.sceneAt(sceneIndex).pushHostDisconnect(connectionId);
  }

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

  callLocalScene(sourceName: string, targetName: string, frame: Uint8Array): Promise<Uint8Array> {
    if (sourceName === targetName) {
      return Promise.reject(new Error(`ordered scene ${sourceName} cannot synchronously call itself`));
    }
    return this.sceneByName(targetName).dispatchLocalCall(frame);
  }

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
