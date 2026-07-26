import { Actor, Component, Scene } from "./entities";
import { component } from "./metadata";
import type { ActorAwakeArgs, ActorCtor } from "./types";

/** 表示一条连接的状态与 Mailbox；业务按需继承并挂载 Component。 / Represents one connection's state and mailbox; business code may extend it and attach Components. */
export class Session<
  TAwakeArgs extends unknown[] = [],
> extends Actor<TAwakeArgs> {
  get ConnectionId(): number {
    if (typeof this.Id !== "number") {
      throw new Error(`session connection id must be a number: ${String(this.Id)}`);
    }
    return this.Id;
  }
}

@component()
export class SessionComponent extends Component {
  private readonly sessions = new Map<number, Session<any[]>>();

  /** 创建并索引连接 Session；同一连接不能重复创建。 / Creates and indexes a connection Session; one connection cannot be created twice. */
  Create<T extends Session<any[]>>(
    connectionId: number,
    ctor: ActorCtor<T>,
    ...awakeArgs: ActorAwakeArgs<T>
  ): T {
    if (!Number.isSafeInteger(connectionId) || connectionId <= 0) {
      throw new Error(`invalid connection id: ${connectionId}`);
    }
    if (this.sessions.has(connectionId)) {
      throw new Error(`session already exists: ${connectionId}`);
    }

    const scene = this.DomainScene<Scene>();
    const session = scene.SpawnActor(connectionId, ctor, ...awakeArgs);
    this.sessions.set(connectionId, session);
    session.__setParent(this);
    return session;
  }

  /** 按连接 ID 查询 Session，不创建新状态。 / Finds a Session by connection ID without creating state. */
  Get<T extends Session<any[]> = Session<any[]>>(connectionId: number): T | undefined {
    return this.sessions.get(connectionId) as T | undefined;
  }

  /** 返回稳定 Session 数组，供超时扫描和优雅停机使用。 / Returns a stable Session array for timeout scans and graceful shutdown. */
  GetAll<T extends Session<any[]> = Session<any[]>>(): readonly T[] {
    return [...this.sessions.values()] as T[];
  }

  /** 移除并销毁 Session，自动取消其定时器和 Component。 / Removes and disposes a Session, including its timers and Components. */
  Remove(connectionId: number): Session<any[]> | undefined {
    const session = this.sessions.get(connectionId);
    if (!session) return undefined;
    this.sessions.delete(connectionId);
    this.DomainScene<Scene>().DespawnActor(connectionId);
    return session;
  }

  /** 仅供 ProcessHost 在底层销毁 Session 时同步清理连接索引。 / Lets ProcessHost clear the connection index when it destroys a Session internally. */
  __detach(connectionId: number): void {
    this.sessions.delete(connectionId);
  }

  get Count(): number {
    return this.sessions.size;
  }

  protected override OnDestroy(): void {
    for (const connectionId of [...this.sessions.keys()]) this.Remove(connectionId);
  }
}
