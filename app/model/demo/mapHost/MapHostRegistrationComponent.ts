import { Component, GlobalIdSystem } from "../../../core/public";
import type {
  S2MM_MapHostHeartbeat,
  S2MM_RegisterMapHost,
} from "../../../generated/model/server/demo/protocol/messages";
import { MapHostControlProtocol } from "../../../generated/model/server/demo/protocol/rpcs";
import { MapHostComponent } from "./MapHostComponent";

/**
 * MapHost到MapManager的注册与租约客户端。只汇报地址、负载和幂等创建关系，
 * 不把玩家、AOI或副本业务数据复制到Manager。
 *
 * Registration and lease client from MapHost to MapManager. It reports only
 * endpoint, load, and creation assignments, never player/AOI/gameplay state.
 */
export class MapHostRegistrationComponent extends Component {
  private readonly generation = GlobalIdSystem.Instance.Next();
  private mapHost!: MapHostComponent;
  private registered = false;
  private reporting = false;

  /** 绑定同Scene的MapHost，并立即注册；后续每5秒续租。 / Binds the colocated MapHost, registers immediately, and renews every five seconds. */
  protected override Awake(): void {
    this.mapHost = this.owner.GetComponent(MapHostComponent);
    if (!this.owner.self.acceptDynamicMaps) return;
    this.owner.scenes.one("MapManager");
    this.NewRepeatedTimer(5_000, "ReportToMapManager");
    this.NewOnceTimer(0, "ReportToMapManager");
  }

  /** 心跳发现Manager丢失注册时，下一步立刻发送包含完整assignment的注册消息。 / Falls back to a full registration when a heartbeat finds that Manager lost this host. */
  protected async ReportToMapManager(): Promise<void> {
    if (this.reporting) return;
    const manager = this.owner.scenes.one("MapManager");
    this.reporting = true;
    try {
      if (this.registered) {
        const heartbeat = await this.owner.scenes.call(
          manager,
          MapHostControlProtocol.Heartbeat,
          this.heartbeat(),
        );
        if (heartbeat.registered) return;
        this.registered = false;
      }
      const registered = await this.owner.scenes.call(
        manager,
        MapHostControlProtocol.Register,
        this.registration(),
      );
      this.registered = registered.accepted;
      if (!registered.accepted) {
        this.owner.logger.warn("map host registration rejected by an active generation", {
          mapHostName: this.owner.self.name,
          generation: this.generation.toString(),
        });
      }
    } catch (error) {
      this.registered = false;
      this.owner.logger.warn("map host registration report failed", { error });
    } finally {
      this.reporting = false;
    }
  }

  private registration(): S2MM_RegisterMapHost {
    const load = this.mapHost.LoadSnapshot();
    return {
      endpoint: this.mapHost.EndpointSnapshot(),
      generation: this.generation,
      staticMapCount: load.staticMapCount,
      dynamicMapCount: load.dynamicMapCount,
      playerCount: load.playerCount,
      assignments: this.mapHost.DynamicAssignments(),
    };
  }

  private heartbeat(): S2MM_MapHostHeartbeat {
    const load = this.mapHost.LoadSnapshot();
    return {
      mapHostName: this.owner.self.name,
      generation: this.generation,
      staticMapCount: load.staticMapCount,
      dynamicMapCount: load.dynamicMapCount,
      playerCount: load.playerCount,
    };
  }

  private get owner() {
    return this.GetParent<import("../../../core/public").EntryScene>();
  }
}
