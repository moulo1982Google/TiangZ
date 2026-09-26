import path from "node:path";
import ts from "typescript";

/** 未保存文本和当前 Program 的有界所有者；不写源码或编译输出。 / Own bounded overlays and current Programs without writing source or compiler output. */
export class ModuleTypeCache {
  constructor({ maxFiles = 10_000, maxBytes = 128 * 1024 * 1024, maxPrograms = 16 } = {}) {
    this.limits = { maxFiles, maxBytes, maxPrograms };
    this.scripts = new Map();
    this.programs = new Map();
    this.overlays = new Map();
    this.bytes = 0;
    this.revision = 0;
  }

  /** 每次替换全部未保存状态；关闭文档自然恢复磁盘。 / Replace the complete overlay set so closed documents revert to disk. */
  setOverlays(overlays) {
    this.overlays = new Map(overlays.map(({ file, text }) => [this.key(file), text]));
  }

  /** 复用同一模块的未变 AST 和旧 Program，保持宿主自己的解析器。 / Reuse unchanged ASTs and the prior Program with the host's resolver. */
  createProgram(moduleId, { rootNames, options, host }) {
    if (rootNames.length > this.limits.maxFiles || (!this.programs.has(moduleId) && this.programs.size >= this.limits.maxPrograms)) throw new Error("Module type cache capacity exceeded");
    host.readFile = file => this.overlays.get(this.key(file)) ?? ts.sys.readFile(file);
    host.getSourceFile = (file, languageVersion, onError, shouldCreateNewSourceFile) => {
      const text = host.readFile(file);
      if (text === undefined) return undefined;
      const key = `${moduleId}\0${this.key(file)}`;
      const cached = this.scripts.get(key);
      const parsing = JSON.stringify(languageVersion);
      if (cached?.text === text && cached.parsing === parsing && !shouldCreateNewSourceFile) return cached.source;
      const size = Buffer.byteLength(text, "utf8");
      const nextBytes = this.bytes + size - (cached?.size ?? 0);
      if ((!cached && this.scripts.size >= this.limits.maxFiles) || nextBytes > this.limits.maxBytes) throw new Error("Module type source cache capacity exceeded");
      const source = ts.createSourceFile(file, text, languageVersion, true);
      source.version = String(++this.revision);
      this.scripts.set(key, { text, parsing, size, source });
      this.bytes = nextBytes;
      return source;
    };
    const program = ts.createProgram({ rootNames, options, host, oldProgram: this.programs.get(moduleId) });
    this.programs.set(moduleId, program);
    this.prune();
    return program;
  }

  /** 仅保留各模块当前依赖图，不积累编辑历史。 / Retain only each module's current dependency graph, never edit history. */
  prune() {
    const retained = new Set();
    for (const [moduleId, program] of this.programs) {
      for (const source of program.getSourceFiles()) retained.add(`${moduleId}\0${this.key(source.fileName)}`);
    }
    for (const [key, script] of this.scripts) {
      if (!retained.has(key)) { this.scripts.delete(key); this.bytes -= script.size; }
    }
  }

  /** 工程退出或类型环境失效时释放全部引用。 / Release all references on project exit or unavailable type environments. */
  dispose() {
    this.programs.clear();
    this.scripts.clear();
    this.overlays.clear();
    this.bytes = 0;
  }

  get stats() { return { programs: this.programs.size, sourceFiles: this.scripts.size, sourceBytes: this.bytes }; }

  key(file) {
    const absolute = path.resolve(file);
    return ts.sys.useCaseSensitiveFileNames ? absolute : absolute.toLowerCase();
  }
}
