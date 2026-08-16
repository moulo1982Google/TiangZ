export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly response?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "RpcError";
  }
}
