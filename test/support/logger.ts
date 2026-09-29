import type { LoggerService } from '@nestjs/common';

export interface CapturedLine {
  level: string;
  message: string;
  /** The second argument Nest passes: a stack for `error`, a context otherwise. */
  detail?: string;
  /** When it was logged, for cases that align with a scheduler's tick. */
  at: number;
}

/**
 * A logger that keeps every line, for the cases that assert what an operator
 * would read.
 *
 * Handed to `bootTestApp`, which sets it before `app.init()`, so lines logged
 * while the app boots are kept too. It captures below `LOG_LEVEL`: the level
 * filter is Nest's, applied to the default logger this replaces.
 */
export class CapturingLogger implements LoggerService {
  readonly lines: CapturedLine[] = [];

  log = (message: unknown, detail?: unknown) => this.push('log', message, detail);
  error = (message: unknown, detail?: unknown) => this.push('error', message, detail);
  warn = (message: unknown, detail?: unknown) => this.push('warn', message, detail);
  debug = (message: unknown, detail?: unknown) => this.push('debug', message, detail);
  verbose = (message: unknown, detail?: unknown) => this.push('verbose', message, detail);

  of(level: string, pattern?: RegExp): CapturedLine[] {
    return this.lines.filter(
      (line) => line.level === level && (!pattern || pattern.test(line.message)),
    );
  }

  matching(pattern: RegExp): CapturedLine[] {
    return this.lines.filter((line) => pattern.test(line.message));
  }

  clear(): void {
    this.lines.length = 0;
  }

  private push(level: string, message: unknown, detail?: unknown): void {
    this.lines.push({
      level,
      message: typeof message === 'string' ? message : String(message),
      ...(detail === undefined ? {} : { detail: String(detail) }),
      at: Date.now(),
    });
  }
}
