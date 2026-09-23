import { Singleton, SingletonRegistry } from "../runtime/Singleton";

/**
 * 部署环境，取值与部署工具一致；宿主在解析配置时已拒绝未知值。
 * Deployment environment matching the deployment tooling; the host rejects unknown values at parse time.
 */
export type ProcessEnvironment = "development" | "test" | "staging" | "production";

const ENVIRONMENTS: readonly ProcessEnvironment[] = Object.freeze([
  "development",
  "test",
  "staging",
  "production",
]);

/** 仅本文件持有的安装令牌；业务代码拿不到，因此无法重装或改写环境。 / Install token private to this file, so business code cannot reinstall or rewrite the environment. */
const INSTALL_TOKEN = Symbol("ProcessRuntimeInfo.install");

/** 启动时装入的进程身份输入。 / Process identity input installed at startup. */
export interface ProcessRuntimeInfoInput {
  readonly name: string;
  readonly environment?: ProcessEnvironment;
}

/**
 * Process 级只读运行信息；EntryScene 之外的 System、Component 和 Hotfix 也能读取。
 * 框架只提供环境取值，不解释它；按环境切换行为（例如是否允许开发账号）由业务决定。
 *
 * Process-wide read-only runtime information, readable outside EntryScene by Systems,
 * Components and Hotfix code. Core only reports the environment; business code decides
 * what differs per environment (for example whether development accounts are allowed).
 */
export class ProcessRuntimeInfo extends Singleton {
  private processName = "";
  private environment: ProcessEnvironment = "development";
  private installed = false;

  static get Instance(): ProcessRuntimeInfo {
    return SingletonRegistry.Get(ProcessRuntimeInfo);
  }

  /** 进程配置中的 `process.name`。 / The configured `process.name`. */
  get Name(): string {
    return this.processName;
  }

  /** 进程配置中的 `process.environment`；配置省略时为 `development`。 / The configured `process.environment`; `development` when omitted. */
  get Environment(): ProcessEnvironment {
    return this.environment;
  }

  get IsProduction(): boolean {
    return this.environment === "production";
  }

  /** Core启动钩子；只接受启动流程的私有令牌，Process构造后业务代码不能修改。 / Core bootstrap hook; only the bootstrap's private token is accepted, so business code cannot change it after process construction. */
  __install(input: ProcessRuntimeInfoInput, token?: symbol): void {
    if (token !== INSTALL_TOKEN) throw new Error("process runtime info can only be installed by the Core process bootstrap");
    if (this.installed) throw new Error("process runtime info is already installed");
    if (typeof input?.name !== "string" || input.name.length === 0) {
      throw new Error("process runtime info requires a process name");
    }
    const environment = input.environment ?? "development";
    if (!ENVIRONMENTS.includes(environment)) {
      throw new Error(`invalid process environment: ${String(environment)}`);
    }
    this.processName = input.name;
    this.environment = environment;
    this.installed = true;
  }

  // 销毁时不清空状态：下一个Process会通过注册表创建新实例；若业务直接调用 __destroy，也不能把环境改回 development。
  // State is not cleared on destroy: the next Process gets a fresh instance from the registry, and a direct
  // business call to __destroy cannot flip the environment back to development.
}

/** 仅供内部Process启动使用的入口。 / Internal process-bootstrap entrypoint. */
export function InitializeProcessRuntimeInfo(input: ProcessRuntimeInfoInput): void {
  SingletonRegistry.Add(ProcessRuntimeInfo).__install(input, INSTALL_TOKEN);
}
