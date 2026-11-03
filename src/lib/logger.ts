type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export type LogContext = {
  correlation_id?: string;
  webhook_event_id?: string;
  job_id?: string;
  agent_run_id?: string;
  tool_call_id?: string;
  workspace_id?: string;
  user_id?: string;
  conversation_id?: string;
  [key: string]: unknown;
};

function currentLevel(): LogLevel {
  const raw = (process.env.LOG_LEVEL || "info").toLowerCase();
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error") {
    return raw;
  }
  return "info";
}

const SENSITIVE_KEYS = [
  "password",
  "password_hash",
  "token",
  "secret",
  "api_key",
  "authorization",
  "credentials",
  "credentials_ref",
  "verification_code",
  "verification_code_hash",
  "embedding",
];

function redact(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[truncated]";
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEYS.some((s) => k.toLowerCase().includes(s))) {
        out[k] = "[redacted]";
      } else {
        out[k] = redact(v, depth + 1);
      }
    }
    return out;
  }
  if (typeof value === "string" && value.length > 2000) {
    return `${value.slice(0, 2000)}…[truncated]`;
  }
  return value;
}

function write(level: LogLevel, message: string, context?: LogContext) {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[currentLevel()]) return;
  const line = {
    ts: new Date().toISOString(),
    level,
    msg: message,
    service: process.env.APP_NAME || "moope-assessor",
    ...(context ? (redact(context) as LogContext) : {}),
  };
  const serialized = JSON.stringify(line);
  if (level === "error") console.error(serialized);
  else if (level === "warn") console.warn(serialized);
  else console.log(serialized);
}

export const logger = {
  debug: (message: string, context?: LogContext) =>
    write("debug", message, context),
  info: (message: string, context?: LogContext) =>
    write("info", message, context),
  warn: (message: string, context?: LogContext) =>
    write("warn", message, context),
  error: (message: string, context?: LogContext) =>
    write("error", message, context),
  child(base: LogContext) {
    return {
      debug: (message: string, context?: LogContext) =>
        write("debug", message, { ...base, ...context }),
      info: (message: string, context?: LogContext) =>
        write("info", message, { ...base, ...context }),
      warn: (message: string, context?: LogContext) =>
        write("warn", message, { ...base, ...context }),
      error: (message: string, context?: LogContext) =>
        write("error", message, { ...base, ...context }),
    };
  },
};
