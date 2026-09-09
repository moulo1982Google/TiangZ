/** 模块配置的完整候选；schema身份在Model构建时固定。
 * Complete module config candidate with schema identity fixed by the Model build.
 */
export interface ModuleConfigCandidate {
  readonly moduleId: string;
  readonly schemaFingerprint: string;
  readonly dataFingerprint: string;
  readonly tables: Readonly<Record<string, unknown>>;
}

interface ModuleConfigSchema {
  readonly moduleId: string;
  readonly schemaFingerprint: string;
  readonly validate: (tables: Readonly<Record<string, unknown>>) => void;
}

/** 进程内模块配置目录；每次发布整组不可变快照，旧引用继续有效。
 * Process-local module config catalog; publishes complete immutable snapshots and preserves old references.
 */
export class ModuleConfigRegistry {
  private static schemas: readonly ModuleConfigSchema[] = Object.freeze([]);
  private static snapshots: ReadonlyMap<string, ModuleConfigCandidate> = new Map();
  private static configured = false;
  private static generation = 0;

  /** 读取当前模块快照；未安装时明确失败。
   * Reads a module snapshot, failing explicitly before installation.
   */
  static Get(moduleId: string): ModuleConfigCandidate {
    const snapshot = this.snapshots.get(moduleId);
    if (!snapshot) throw new Error(`module config is not installed: ${moduleId}`);
    return snapshot;
  }

  /** 提供快照代次用于诊断，不暴露可写目录。
   * Exposes snapshot generation for diagnostics without exposing writable catalogs.
   */
  static get Generation(): number { return this.generation; }

  /** 只供生成的Model入口声明schema，不允许运行时添加模块。
   * Generated Model bootstrap only; runtime module additions are forbidden.
   */
  static __configure(schemas: readonly ModuleConfigSchema[]): void {
    if (this.configured) throw new Error("module config schemas are sealed");
    const ids = new Set<string>();
    for (const schema of schemas) {
      if (ids.has(schema.moduleId)) throw new Error(`duplicate module config schema: ${schema.moduleId}`);
      if (!/^[a-f0-9]{64}$/.test(schema.schemaFingerprint)) throw new Error("invalid module schema fingerprint");
      ids.add(schema.moduleId);
    }
    this.schemas = Object.freeze(schemas.map((schema) => Object.freeze({ ...schema })));
    this.configured = true;
  }

  /** 内部控制面先验证全部候选，再返回一次性的无回调提交操作。
   * Internal control plane validates all candidates before returning a one-shot callback-free commit.
   */
  static __prepare(inputs: readonly ModuleConfigCandidate[]): () => void {
    if (!this.configured) throw new Error("module config schemas are not configured");
    if (!Array.isArray(inputs) || inputs.length !== this.schemas.length) throw new Error("module config catalog changed; restart required");
    const next = new Map<string, ModuleConfigCandidate>();
    for (const input of inputs) {
      const schema = this.schemas.find((item) => item.moduleId === input?.moduleId);
      if (!schema || next.has(input.moduleId)) throw new Error("unknown or duplicate module config owner");
      if (schema.schemaFingerprint !== input.schemaFingerprint) throw new Error(`module config schema changed; restart required: ${input.moduleId}`);
      if (!/^[a-f0-9]{64}$/.test(input.dataFingerprint)) throw new Error("invalid module data fingerprint");
      const tables = cloneJson(input.tables);
      if (!tables || Array.isArray(tables) || typeof tables !== "object") throw new Error("module config tables must be an object");
      freezeJson(tables);
      schema.validate(tables as Record<string, unknown>);
      next.set(input.moduleId, Object.freeze({ ...input, tables }) as ModuleConfigCandidate);
    }
    const generation = this.generation;
    let committed = false;
    return () => {
      if (committed || generation !== this.generation) throw new Error("stale module config transaction");
      this.snapshots = next;
      this.generation++;
      committed = true;
    };
  }
}

/** 候选来源于宿主JSON；再次克隆以隔离调用方可变引用。
 * Host candidates are JSON; clone again to isolate caller-owned mutable references.
 */
function cloneJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

/** 冻结克隆后的JSON，不触碰模块实例或运行中的业务状态。
 * Freezes cloned JSON without touching module instances or live business state.
 */
function freezeJson(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  for (const child of Object.values(value)) freezeJson(child);
  Object.freeze(value);
}
