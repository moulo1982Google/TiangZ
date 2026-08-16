export class RpcError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly response?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "RpcError";
  }
}
