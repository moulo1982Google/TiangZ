export type LogLevel = "trace" | "debug" | "info" | "warn" | "error";
export type LogCategory = "framework" | "business" | "application";

export interface LogFields {
  readonly category?: LogCategory;
  readonly process?: string;
  readonly scene?: string;
  readonly sceneType?: string;
  readonly actorId?: number | string;
  readonly connectionId?: number;
  readonly rpcId?: number;
  readonly msgcode?: number;
  readonly traceId?: string;
  readonly unitId?: number | string;
  readonly [key: string]: unknown;
}

type HostLog = (
  level: number,
  target: string,
  category: string,
  message: string,
  attributes: string,
) => void;

const levelCodes: Readonly<Record<LogLevel, number>> = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
};

export class Logger {
  constructor(
    private readonly target: string,
    private readonly boundFields: LogFields = {},
  ) {}

  child(fields: LogFields): Logger {
    return new Logger(this.target, { ...this.boundFields, ...fields });
  }

  trace(message: string, fields?: LogFields): void {
    this.write("trace", message, fields);
  }

  debug(message: string, fields?: LogFields): void {
    this.write("debug", message, fields);
  }

  info(message: string, fields?: LogFields): void {
    this.write("info", message, fields);
  }

  warn(message: string, fields?: LogFields): void {
    this.write("warn", message, fields);
  }

  error(message: string, fields?: LogFields): void {
    this.write("error", message, fields);
  }

  private write(level: LogLevel, message: string, fields: LogFields = {}): void {
    const attributes = { ...this.boundFields, ...fields };
    const category = attributes.category ?? "application";
    delete (attributes as { category?: LogCategory }).category;
    const hostLog = (globalThis as typeof globalThis & { __hostLog?: HostLog }).__hostLog;
    if (!hostLog) {
      console[level === "trace" ? "debug" : level](message, attributes);
      return;
    }
    hostLog(levelCodes[level], this.target, category, message, serialize(attributes));
  }
}

export const CoreLogger = new Logger("core", { category: "framework" });

function serialize(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, nested) => {
      if (typeof nested === "bigint") return nested.toString();
      if (nested instanceof Error) {
        return {
          name: nested.name,
          message: nested.message,
          stack: nested.stack,
        };
      }
      return nested;
    });
  } catch (error) {
    return JSON.stringify({
      serializationError: error instanceof Error ? error.message : String(error),
    });
  }
}
