import type { HotfixManifest, HotfixStatus } from "./contracts";
import {
  getRequiredLifecycleMethods,
  getRequiredTransferMethods,
} from "../runtime/metadata";

type AnyCtor = abstract new (...args: any[]) => object;
type ConcreteCtor = new (...args: any[]) => object;

interface MethodCandidate {
  readonly target: AnyCtor;
  readonly implementation: ConcreteCtor;
  readonly required: boolean;
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
  required: boolean;
}

interface BindingUndo<T extends object> {
  readonly store: HotfixBindingStore<T>;
  readonly key: string;
  readonly previous?: T;
  readonly previousSnapshot?: PropertyDescriptorMap;
}

interface PrototypeUndo {
  readonly target: AnyCtor;
  readonly descriptors: Map<PropertyKey, PropertyDescriptor | undefined>;
  readonly previousMethods: Set<PropertyKey>;
  readonly previousRequired: boolean;
  readonly wasInstalled: boolean;
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
  private static readonly requiredTypes = new Set<AnyCtor>();
  private static readonly installedTypes = new Map<AnyCtor, InstalledType>();
  private static readonly bindingStores = new Set<HotfixBindingStore<object>>();

  /** 记录参与完整generation校验的稳定Handler槽；仅由HotfixBindingStore构造时调用。 / Tracks stable Handler slots that participate in complete-generation validation; called only by HotfixBindingStore construction. */
  static RegisterBindingStore<T extends object>(store: HotfixBindingStore<T>): void {
    this.bindingStores.add(store as unknown as HotfixBindingStore<object>);
  }

  /** 注册Model要求的业务System；Generated Bootstrap通常在首个候选前调用，暂存期间禁止修改。 / Registers a Model-required business System, normally before the first candidate; registration is forbidden while staging. */
  static RequireType(target: AnyCtor): void {
    if (this.staging) {
      throw new Error(`required System registration is closed: ${target.name}`);
    }
    this.requiredTypes.add(target);
  }

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
  static StageType(
    target: AnyCtor,
    implementation: ConcreteCtor,
    required = false,
  ): void {
    const staging = this.requireStaging();
    if (staging.methods.some((candidate) => candidate.target === target)) {
      throw new Error(`duplicate hotfix implementation: ${target.name}`);
    }
    staging.methods.push({ target, implementation, required });
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
    const prototypeUndo: PrototypeUndo[] = [];
    const bindingUndo: BindingUndo<object>[] = [];

    try {
      validateCompleteBindings(staging, this.bindingStores, this.generation > 0);
      const requiredTargets = new Set(this.requiredTypes);
      for (const [target, installed] of this.installedTypes) {
        if (installed.required) requiredTargets.add(target);
      }
      for (const target of requiredTargets) {
        const candidate = staging.methods.find((item) => item.target === target);
        if (!candidate) throw new Error(`required System is missing: ${target.name}`);
        if (!candidate.required) throw new Error(`required System must use @systemFor: ${target.name}`);
        validateRequiredLifecycle(candidate);
      }
      const nextTargets = new Set(staging.methods.map((candidate) => candidate.target));
      for (const [target, installed] of this.installedTypes) {
        if (nextTargets.has(target)) continue;
        prototypeUndo.push(snapshotInstalled(target, installed, true));
        restoreBaseline(target, installed);
        installed.methods.clear();
      }

      for (const candidate of staging.methods) {
        const wasInstalled = this.installedTypes.has(candidate.target);
        const installed = this.installedTypes.get(candidate.target) ?? {
          baseline: new Map<PropertyKey, PropertyDescriptor | undefined>(),
          methods: new Set<PropertyKey>(),
          required: false,
        };
        if (!this.installedTypes.has(candidate.target)) {
          this.installedTypes.set(candidate.target, installed);
        }
        prototypeUndo.push(snapshotInstalled(
          candidate.target,
          installed,
          wasInstalled,
          Reflect.ownKeys(candidate.implementation.prototype).filter((key) => key !== "constructor"),
        ));
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
      const rollbackErrors: unknown[] = [];
      for (const undo of bindingUndo.reverse()) {
        try {
          undo.store.__rollback(undo);
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      for (const undo of prototypeUndo.reverse()) {
        try {
          restorePrototypeUndo(undo, this.installedTypes);
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      const failure = rollbackErrors.length === 0
        ? error
        : new AggregateError(
          [error, ...rollbackErrors],
          "hotfix commit failed and rollback reported additional errors",
        );
      this.lastError = errorText(failure);
      this.staging = undefined;
      // 回滚是尽力恢复，不得把Runtime永久留在rolling-back阶段；即使某个恢复动作失败，
      // 后续候选仍必须可以重新Begin，让宿主决定是否重启或人工介入。
      // Rollback is best-effort and must never leave the Runtime permanently
      // in rolling-back; later candidates must still be able to Begin.
      this.phase = "idle";
      throw failure;
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
 * 声明 Model 类型的必需业务 System。第一代提交后，后续候选必须继续提供该
 * System；缺失候选会整体拒绝并保留旧 generation，避免生命周期悄悄退回空实现。
 *
 * Declares a required business System for a Model type. Once installed in the
 * first generation, every later candidate must provide it; omission rejects
 * the whole candidate and preserves the active generation.
 */
export function systemFor<TTarget extends AnyCtor>(
  target: TTarget,
): <TImplementation extends ConcreteCtor>(implementation: TImplementation) => void {
  return (implementation) => {
    if (!(implementation.prototype instanceof target)) {
      throw new Error(`${implementation.name} must extend ${target.name}`);
    }
    HotfixSystem.StageType(target, implementation, true);
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

  constructor(readonly Name: string) {
    HotfixSystem.RegisterBindingStore(this);
  }

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

  /** 仅供Hotfix事务在修改任何活动行为前校验候选是否包含完整旧绑定集合。 / Lets the Hotfix transaction validate the complete active key set before mutating serving behavior. */
  __activeKeys(): readonly string[] {
    return [...this.active.keys()];
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

/**
 * 第一代建立Handler key基线，后续拒绝任何集合增减。当前稳定路由持有binding槽对象，
 * 因此新增、删除或重命名Handler都属于Model/协议变更，必须完整重启。
 *
 * Establishes Handler keys in generation one and rejects any later key-set
 * change. Stable routes retain binding slots, so add/remove/rename requires a
 * full Model restart rather than a partial Hotfix update.
 */
function validateCompleteBindings(
  staging: StagingGeneration,
  stores: ReadonlySet<HotfixBindingStore<object>>,
  frozen: boolean,
): void {
  const stagedKeys = new Map<HotfixBindingStore<object>, Set<string>>();
  for (const candidate of staging.bindings) {
    let keys = stagedKeys.get(candidate.store);
    if (!keys) {
      keys = new Set<string>();
      stagedKeys.set(candidate.store, keys);
    }
    keys.add(candidate.key);
  }

  if (!frozen) return;

  for (const store of stores) {
    const keys = stagedKeys.get(store);
    const activeKeys = new Set(store.__activeKeys());
    for (const activeKey of activeKeys) {
      if (!keys?.has(activeKey)) {
        throw new Error(`active Hotfix binding is missing: ${store.Name}:${activeKey}`);
      }
    }
    for (const stagedKey of keys ?? []) {
      if (!activeKeys.has(stagedKey)) {
        throw new Error(`new Hotfix binding requires restart: ${store.Name}:${stagedKey}`);
      }
    }
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
    // 先记录正在写入的方法，再执行defineProperty；若后续方法失败，事务快照才能清掉
    // 本次已经成功写入的前置方法，避免首次安装留下半套prototype。
    // Record the method before defineProperty so a later failure can remove
    // earlier writes and cannot leak a partial first installation.
    installed.methods.add(method);
    Object.defineProperty(candidate.target.prototype, method, descriptor);
  }
  installed.methods = nextMethods;
  installed.required ||= candidate.required;
}

/**
 * 只接受候选类自己声明的生命周期实现，不能让 Model/Core 的空钩子冒充业务实现。
 * Only methods owned by the candidate prototype satisfy the contract; empty
 * Model/Core fallback hooks must never masquerade as business implementations.
 */
function validateRequiredLifecycle(candidate: MethodCandidate): void {
  for (const method of getRequiredLifecycleMethods(candidate.target)) {
    validateLifecycleMethod(candidate, method, false);
  }
  for (const method of getRequiredTransferMethods(candidate.target)) {
    validateLifecycleMethod(candidate, method, true);
  }
}

function validateLifecycleMethod(
  candidate: MethodCandidate,
  method: string,
  allowStableModel: boolean,
): void {
  const descriptor = Object.getOwnPropertyDescriptor(
    candidate.implementation.prototype,
    method,
  ) ?? (allowStableModel
    ? Object.getOwnPropertyDescriptor(candidate.target.prototype, method)
    : undefined);
  if (!descriptor || typeof descriptor.value !== "function") {
    throw new Error(
      `required lifecycle method is missing: ${candidate.target.name}.${method}`,
    );
  }
  if (descriptor.value.constructor?.name === "AsyncFunction") {
    throw new Error(
      `lifecycle method must be synchronous: ${candidate.target.name}.${method}`,
    );
  }
}

function snapshotInstalled(
  target: AnyCtor,
  installed: InstalledType,
  wasInstalled: boolean,
  candidateMethods: Iterable<PropertyKey> = [],
): PrototypeUndo {
  const descriptors = new Map<PropertyKey, PropertyDescriptor | undefined>();
  const methods = new Set<PropertyKey>(installed.methods);
  for (const method of candidateMethods) methods.add(method);
  for (const method of methods) {
    descriptors.set(method, Object.getOwnPropertyDescriptor(target.prototype, method));
  }
  return {
    target,
    descriptors,
    previousMethods: new Set(installed.methods),
    previousRequired: installed.required,
    wasInstalled,
  };
}

function restoreBaseline(target: AnyCtor, installed: InstalledType): void {
  for (const method of installed.methods) {
    const baseline = installed.baseline.get(method);
    if (baseline) Object.defineProperty(target.prototype, method, baseline);
    else Reflect.deleteProperty(target.prototype, method);
  }
}

function restorePrototypeUndo(
  undo: PrototypeUndo,
  installedTypes: Map<AnyCtor, InstalledType>,
): void {
  const installed = installedTypes.get(undo.target);
  if (!installed) return;
  for (const method of installed.methods) {
    // 如果候选方法覆盖的是原本存在的不可配置属性，defineProperty会直接失败；
    // 回滚时不能再删除这个仍属于基线的属性，只需由下面的descriptor恢复它。
    // When a candidate attempted to overwrite a pre-existing non-configurable
    // property, defineProperty already failed. Do not delete that baseline
    // property during rollback; the descriptor restoration below is enough.
    if (
      !undo.previousMethods.has(method) &&
      undo.descriptors.get(method) === undefined
    ) {
      Reflect.deleteProperty(undo.target.prototype, method);
    }
  }
  for (const [method, descriptor] of undo.descriptors) {
    if (descriptor) Object.defineProperty(undo.target.prototype, method, descriptor);
    else Reflect.deleteProperty(undo.target.prototype, method);
  }
  installed.methods = undo.previousMethods;
  installed.required = undo.previousRequired;
  if (!undo.wasInstalled) installedTypes.delete(undo.target);
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
