export type MaybePromise<T> = T | Promise<T>;

/** 检测 Handler 是否返回异步结果，同时避免同步快路径产生额外 Promise 分配。 / Detects async handler results without forcing synchronous fast paths through Promise allocation. */
export function isPromiseLike<T>(value: MaybePromise<T>): value is Promise<T> {
  return (
    (typeof value === "object" && value !== null) ||
    typeof value === "function"
  ) && typeof (value as PromiseLike<T>).then === "function";
}
