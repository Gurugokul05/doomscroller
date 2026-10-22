import fs from 'node:fs';
import path from 'node:path';
import { errorMessage } from '../util/errors';

export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

type Level = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

export interface LoggerOptions {
  filePath?: string;
  console?: boolean;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  let directoryReady = false;

  const write = (level: Level, message: string): void => {
    const line = `[${new Date().toISOString()}] ${level} ${message}`;
    if (options.console) {
      try {
        process.stderr.write(`${line}\n`);
      } catch {
        // Logging must never be the reason something fails.
      }
    }
    if (!options.filePath) return;
    try {
      if (!directoryReady) {
        fs.mkdirSync(path.dirname(options.filePath), { recursive: true });
        directoryReady = true;
      }
      fs.appendFileSync(options.filePath, `${line}\n`, 'utf8');
    } catch {
      // Intentionally silent.
    }
  };

  return {
    debug: (message) => write('DEBUG', message),
    info: (message) => write('INFO', message),
    warn: (message) => write('WARN', message),
    error: (message) => write('ERROR', message),
  };
}

export const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

export function logCaught(logger: Logger, context: string, error: unknown): void {
  logger.warn(`${context}: ${errorMessage(error)}`);
}
