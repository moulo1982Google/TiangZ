import {
  RpcError,
  SystemErrCode,
  type SceneConfig,
} from "../../../core/public";
import type {
  MapHostEndpoint,
  MapInstanceSnapshot,
} from "../../../generated/model/server/demo/protocol/messages";

/** 把已校验的Scene配置压缩成可随Location传递的MapHost地址。 / Converts a validated Scene route into the endpoint carried by Location. */
export function MapHostEndpointFromScene(scene: SceneConfig): MapHostEndpoint {
  if (scene.sceneType !== "MapHost") {
    throw new RpcError(SystemErrCode.MalformedFrame, `scene is not a MapHost: ${scene.name}`);
  }
  return {
    name: scene.name,
    ip: scene.innerIp,
    port: scene.port,
    protocol: scene.protocol ?? "",
    audience: scene.audience ?? "",
  };
}

/** 校验Manager或Location返回的MapHost地址并转换为运行时Scene路由。 / Validates a MapHost endpoint returned by Manager or Location and converts it to a runtime route. */
export function SceneConfigFromMapHostEndpoint(endpoint: MapHostEndpoint): SceneConfig {
  if (!endpoint.name || !endpoint.ip || endpoint.port <= 0 || endpoint.port > 65_535) {
    throw new RpcError(SystemErrCode.MalformedFrame, "invalid MapHost endpoint");
  }
  const protocol = endpoint.protocol;
  if (
    protocol &&
    protocol !== "auto" &&
    protocol !== "tcp" &&
    protocol !== "websocket" &&
    protocol !== "kcp"
  ) {
    throw new RpcError(SystemErrCode.MalformedFrame, "invalid MapHost protocol");
  }
  if (endpoint.audience && endpoint.audience !== "inner" && endpoint.audience !== "mixed") {
    throw new RpcError(SystemErrCode.MalformedFrame, "MapHost endpoint must be inner or mixed");
  }
  const normalizedProtocol: SceneConfig["protocol"] =
    protocol === "auto" ||
    protocol === "tcp" ||
    protocol === "websocket" ||
    protocol === "kcp"
      ? protocol
      : undefined;
  return {
    name: endpoint.name,
    sceneType: "MapHost",
    innerIp: endpoint.ip,
    port: endpoint.port,
    protocol: normalizedProtocol,
    audience: endpoint.audience === "inner" || endpoint.audience === "mixed"
      ? endpoint.audience
      : undefined,
  };
}

/** 从地图实例取得宿主路由，并拒绝名称与Endpoint不一致的损坏记录。 / Resolves a host route from a map instance and rejects mismatched names. */
export function SceneConfigFromMapInstance(instance: MapInstanceSnapshot): SceneConfig {
  const scene = SceneConfigFromMapHostEndpoint(instance.mapHost);
  if (scene.name !== instance.mapHostName) {
    throw new RpcError(
      SystemErrCode.LocationConflict,
      `map instance host name conflicts: ${instance.mapHostName}/${scene.name}`,
    );
  }
  return scene;
}
