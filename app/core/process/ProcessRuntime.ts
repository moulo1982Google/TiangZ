import type { MaybePromise } from "../async";
import {
  Game,
  InitializeGameSingletons,
  ProcessHost,
  TimeSystem,
  TimerSystem,
  UpdateSystem,
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

  constructor(private readonly config: ProcessRuntimeConfig) {
    InitializeGameSingletons(config.process.game);
    const processHost = new ProcessHost(config.process.name);
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
        processHost,
        localRouter: this,
      });
      if (this.scenesByName.has(scene.name)) throw new Error(`duplicate local scene: ${scene.name}`);
      this.scenesByName.set(scene.name, instance);
      return instance;
    });
  }

  start(): string {
    const started = this.entryScenes.map((scene) => scene.start()).join("\n");
    return `[process:${this.config.process.name}] one V8 started with ${this.entryScenes.length} scene(s)\n${started}`;
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
      includeMetrics,
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
}

function mergeResults(
  results: SceneUpdateResult[],
  includeMetrics: boolean,
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
