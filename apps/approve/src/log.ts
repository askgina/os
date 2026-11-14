export type LogFields = Record<string, string | number | boolean | null | undefined>;

/**
 * One JSON object per line. Fields carry route names, statuses and codes only: never a
 * confirmation token, an approval's content or a passkey assertion.
 */
export interface Logger {
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

export function createLogger(component: string): Logger {
  const write = (level: string, message: string, fields: LogFields = {}) => {
    process.stdout.write(
      `${JSON.stringify({ at: new Date().toISOString(), level, component, message, ...fields })}\n`,
    );
  };
  return {
    info: (message, fields) => write("info", message, fields),
    warn: (message, fields) => write("warn", message, fields),
    error: (message, fields) => write("error", message, fields),
  };
}
