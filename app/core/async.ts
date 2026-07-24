export type MaybePromise<T> = T | Promise<T>;

/** Detects async handler results without forcing synchronous fast paths through Promise allocation. */
export function isPromiseLike<T>(value: MaybePromise<T>): value is Promise<T> {
  return (
    (typeof value === "object" && value !== null) ||
    typeof value === "function"
  ) && typeof (value as PromiseLike<T>).then === "function";
}
