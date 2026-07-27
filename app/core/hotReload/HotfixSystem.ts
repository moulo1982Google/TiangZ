import type { HotfixManifest, HotfixStatus } from "./contracts";

type AnyCtor = abstract new (...args: any[]) => object;
type ConcreteCtor = new (...args: any[]) => object;

interface MethodCandidate {
  readonly target: AnyCtor;
  readonly implementation: ConcreteCtor;
}

interface BindingCandidate<T extends object> {
  readonly store: HotfixBindingStore<T>;
  readonly key: string;
  readonly value: T;
}

interface StagingGeneration {
  readonly manifest: HotfixManifest;
  readonly methods: MethodCandidate[];
  readonly bindings: BindingCandidate<object>[];
}

interface InstalledType {
  readonly baseline: Map<PropertyKey, PropertyDescriptor | undefined>;
  methods: Set<PropertyKey>;
}

interface BindingUndo<T extends object> {
  readonly store: HotfixBindingStore<T>;
  readonly key: string;
  readonly previous?: T;
  readonly previousSnapshot?: PropertyDescriptorMap;
}

/**
 * 管理当前 Process 唯一的 Hotfix generation，并以事务方式安装方法和 Handler。
 * 本系统从不接收 Model 代码，也没有修改构造函数、实例字段或继承关系的接口。
 * 候选加载失败或提交失败时，所有已修改 prototype 与绑定槽都会恢复。
 *
 * Owns the single active Hotfix generation of a Process and installs methods
 * and handlers transactionally. It deliberately exposes no API for changing
 * Model constructors, instance fields, or inheritance. Failed candidates and
 * failed commits restore every touched prototype and binding slot.
 */
export class HotfixSystem {
  private static staging: StagingGeneration | undefined;
  private static activeManifest: HotfixManifest | undefined;
  private static generation = 0;
  private static phase: HotfixStatus["phase"] = "idle";
  private static lastError: string | undefined;
  private static readonly installedTypes = new Map<AnyCtor, InstalledType>();

  /** 在求值候选 Bundle 前建立暂存区；Model 指纹兼容性由 Rust 宿主先行校验。 / Opens staging before candidate evaluation; the Rust host validates Model fingerprints first. */
  static Begin(manifest: HotfixManifest): void {
    if (this.staging || this.phase !== "idle") {
      throw new Error(`hotfix cannot begin while phase is ${this.phase}`);
    }
    if (manifest.formatVersion !== 1) {
      throw new Error(`unsupported hotfix manifest format: ${manifest.formatVersion}`);
    }
    this.lastError = undefined;
    this.phase = "staging";
    this.staging = { manifest, methods: [], bindings: [] };
  }

  /** 放弃尚未提交的候选；模块求值异常时 Rust 必须调用此入口。 / Aborts an uncommitted candidate; Rust must call it when module evaluation fails. */
  static Abort(reason: unknown): void {
    this.lastError = errorText(reason);
    this.staging = undefined;
    this.phase = "idle";
  }

  /** 记录一个完整行为实现类；类只提供 prototype 方法，绝不会被实例化。 / Stages a complete behavior implementation class; it contributes prototype methods and is never instantiated. */
  static StageType(target: AnyCtor, implementation: ConcreteCtor): void {
    const staging = this.requireStaging();
    if (staging.methods.some((candidate) => candidate.target === target)) {
      throw new Error(`duplicate hotfix implementation: ${target.name}`);
    }
    staging.methods.push({ target, implementation });
  }

  /** 记录 Handler 槽候选；提交前不会影响正在服务的 generation。 / Stages a handler slot without changing the currently serving generation. */
  static StageBinding<T extends object>(
    store: HotfixBindingStore<T>,
    key: string,
    value: T,
  ): void {
    const staging = this.requireStaging();
    const duplicate = staging.bindings.some(
      (candidate) => candidate.store === store && candidate.key === key,
    );
    if (duplicate) throw new Error(`duplicate hotfix binding: ${store.Name}:${key}`);
    staging.bindings.push({
      store: store as unknown as HotfixBindingStore<object>,
      key,
      value,
    });
  }

  /**
   * 原子提交候选行为。调用者必须先暂停入站投递并确认旧异步任务已归零。
   * 本方法只执行同步内存修改；任何异常都会在恢复旧状态后重新抛出。
   *
   * Atomically commits candidate behavior. The caller must pause ingress and
   * drain old asynchronous work first. This method performs synchronous memory
   * changes only and rethrows after restoring old state on any failure.
   */
  static Commit(): HotfixStatus {
    const staging = this.requireStaging();
    this.phase = "committing";
    const prototypeUndo: Array<{
      target: AnyCtor;
      descriptors: Map<PropertyKey, PropertyDescriptor | undefined>;
      previousMethods: Set<PropertyKey>;
    }> = [];
    const bindingUndo: BindingUndo<object>[] = [];

    try {
      const nextTargets = new Set(staging.methods.map((candidate) => candidate.target));
      for (const [target, installed] of this.installedTypes) {
        if (nextTargets.has(target)) continue;
        prototypeUndo.push(snapshotInstalled(target, installed));
        restoreBaseline(target, installed);
        installed.methods.clear();
      }

      for (const candidate of staging.methods) {
        const installed = this.installedTypes.get(candidate.target) ?? {
          baseline: new Map<PropertyKey, PropertyDescriptor | undefined>(),
          methods: new Set<PropertyKey>(),
        };
        if (!this.installedTypes.has(candidate.target)) {
          this.installedTypes.set(candidate.target, installed);
        }
        prototypeUndo.push(snapshotInstalled(candidate.target, installed));
        installCandidate(candidate, installed);
      }

      for (const candidate of staging.bindings) {
        bindingUndo.push(candidate.store.__commit(candidate.key, candidate.value));
      }

      this.activeManifest = staging.manifest;
      this.generation += 1;
      this.staging = undefined;
      this.phase = "idle";
      this.lastError = undefined;
      return this.Status();
    } catch (error) {
      this.phase = "rolling-back";
      for (const undo of bindingUndo.reverse()) undo.store.__rollback(undo);
      for (const undo of prototypeUndo.reverse()) restorePrototypeUndo(undo, this.installedTypes);
      this.lastError = errorText(error);
      this.staging = undefined;
      this.phase = "idle";
      throw error;
    }
  }

  static Status(): HotfixStatus {
    return {
      activeVersion: this.activeManifest?.bundleVersion,
      activeGeneration: this.generation,
      stagingVersion: this.staging?.manifest.bundleVersion,
      phase: this.phase,
      lastError: this.lastError,
    };
  }

  static get IsStaging(): boolean {
    return this.staging !== undefined && this.phase === "staging";
  }

  private static requireStaging(): StagingGeneration {
    if (!this.staging || this.phase !== "staging") {
      throw new Error("hotfix registration is only allowed while staging");
    }
    return this.staging;
  }
}

/**
 * 声明某个 Model 类型的完整 Hotfix 行为实现。
 * implementation 必须继承 target；类字段和构造函数不会被复制，写在这里没有效果。
 *
 * Declares the complete Hotfix behavior implementation of a Model type. The
 * implementation must extend the target. Fields and constructors are never
 * copied and therefore do not belong in this class.
 */
export function hotfixFor<TTarget extends AnyCtor>(
  target: TTarget,
): <TImplementation extends ConcreteCtor>(implementation: TImplementation) => void {
  return (implementation) => {
    if (!(implementation.prototype instanceof target)) {
      throw new Error(`${implementation.name} must extend ${target.name}`);
    }
    HotfixSystem.StageType(target, implementation);
  };
}

/**
 * 保存可原地更新的 Handler 绑定槽。Scene 路由持有同一个槽对象，因此提交新构造器
 * 不需要重建 Scene、Session 或 Unit。
 *
 * Stores handler bindings in identity-stable slots. Scene routes retain the
 * same slot object, so a new constructor can be committed without rebuilding
 * Scene, Session, or Unit instances.
 */
export class HotfixBindingStore<T extends object> {
  private readonly active = new Map<string, T>();

  constructor(readonly Name: string) {}

  /** 在候选加载期进入事务暂存；框架单元测试可在无候选时安装一次基线。 / Stages during candidate loading; framework unit tests may install a one-time baseline outside staging. */
  Register(key: string, value: T): void {
    if (HotfixSystem.IsStaging) {
      HotfixSystem.StageBinding(this, key, value);
      return;
    }
    if (this.active.has(key)) {
      throw new Error(`duplicate external handler binding: ${this.Name}:${key}`);
    }
    this.active.set(key, value);
  }

  Values(): readonly T[] {
    return [...this.active.values()];
  }

  __commit(key: string, value: T): BindingUndo<T> {
    const previous = this.active.get(key);
    if (!previous) {
      this.active.set(key, value);
      return { store: this, key };
    }
    const previousSnapshot = Object.getOwnPropertyDescriptors(previous);
    try {
      replaceObjectProperties(previous, value);
    } catch (error) {
      replaceObjectProperties(previous, previousSnapshot);
      throw error;
    }
    return { store: this, key, previous, previousSnapshot };
  }

  __rollback(undo: BindingUndo<T>): void {
    if (!undo.previous) {
      this.active.delete(undo.key);
      return;
    }
    replaceObjectProperties(undo.previous, undo.previousSnapshot ?? {});
    this.active.set(undo.key, undo.previous);
  }
}

function installCandidate(candidate: MethodCandidate, installed: InstalledType): void {
  const descriptors = Object.getOwnPropertyDescriptors(candidate.implementation.prototype);
  Reflect.deleteProperty(descriptors, "constructor");
  const nextMethods = new Set<PropertyKey>(Reflect.ownKeys(descriptors));

  for (const method of installed.methods) {
    if (nextMethods.has(method)) continue;
    const baseline = installed.baseline.get(method);
    if (baseline) Object.defineProperty(candidate.target.prototype, method, baseline);
    else Reflect.deleteProperty(candidate.target.prototype, method);
  }

  for (const method of nextMethods) {
    if (!installed.baseline.has(method)) {
      installed.baseline.set(
        method,
        Object.getOwnPropertyDescriptor(candidate.target.prototype, method),
      );
    }
    const descriptor = Object.getOwnPropertyDescriptor(
      candidate.implementation.prototype,
      method,
    );
    if (!descriptor) throw new Error(`hotfix method descriptor is missing: ${String(method)}`);
    Object.defineProperty(candidate.target.prototype, method, descriptor);
  }
  installed.methods = nextMethods;
}

function snapshotInstalled(target: AnyCtor, installed: InstalledType) {
  const descriptors = new Map<PropertyKey, PropertyDescriptor | undefined>();
  for (const method of installed.methods) {
    descriptors.set(method, Object.getOwnPropertyDescriptor(target.prototype, method));
  }
  return { target, descriptors, previousMethods: new Set(installed.methods) };
}

function restoreBaseline(target: AnyCtor, installed: InstalledType): void {
  for (const method of installed.methods) {
    const baseline = installed.baseline.get(method);
    if (baseline) Object.defineProperty(target.prototype, method, baseline);
    else Reflect.deleteProperty(target.prototype, method);
  }
}

function restorePrototypeUndo(
  undo: ReturnType<typeof snapshotInstalled>,
  installedTypes: Map<AnyCtor, InstalledType>,
): void {
  const installed = installedTypes.get(undo.target);
  if (!installed) return;
  for (const method of installed.methods) {
    if (!undo.previousMethods.has(method)) Reflect.deleteProperty(undo.target.prototype, method);
  }
  for (const [method, descriptor] of undo.descriptors) {
    if (descriptor) Object.defineProperty(undo.target.prototype, method, descriptor);
    else Reflect.deleteProperty(undo.target.prototype, method);
  }
  installed.methods = undo.previousMethods;
}

function replaceObjectProperties(target: object, source: object | PropertyDescriptorMap): void {
  for (const key of Reflect.ownKeys(target)) Reflect.deleteProperty(target, key);
  const descriptors = isDescriptorMap(source)
    ? source
    : Object.getOwnPropertyDescriptors(source);
  Object.defineProperties(target, descriptors);
}

function isDescriptorMap(value: object): value is PropertyDescriptorMap {
  return Object.values(value).every(
    (item) => typeof item === "object" && item !== null &&
      ("value" in item || "get" in item || "set" in item),
  );
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.stack ?? error.message : String(error);
}
