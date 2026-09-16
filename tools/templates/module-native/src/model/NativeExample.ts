import { NativeOps } from "./generated/native/NativeOps";

/** 无状态原生调用示例；从 Hotfix 经本模块桥访问。 / Stateless Native example exposed through the module bridge. */
export class NativeExample {
  static Add(left: number, right: number): number {
    return NativeOps.Add(left, right);
  }
}
