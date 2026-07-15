export type MaybePromise<T> = T | Promise<T>;

export function isPromiseLike<T>(value: MaybePromise<T>): value is Promise<T> {
  return (
    (typeof value === "object" && value !== null) ||
    typeof value === "function"
  ) && typeof (value as PromiseLike<T>).then === "function";
}
