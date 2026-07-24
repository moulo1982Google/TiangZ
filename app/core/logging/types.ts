export interface ProcessLoggingConfig {
  level?: "trace" | "debug" | "info" | "warn" | "error";
  format?: "pretty" | "json";
  console?: boolean;
  filter?: string;
  file?: ProcessLogFileConfig;
}

export interface ProcessLogFileConfig {
  enabled?: boolean;
  directory?: string;
  rotation?: "hourly" | "daily" | "never";
}
