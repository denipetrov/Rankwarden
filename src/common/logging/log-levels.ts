import type { LogLevel } from '@nestjs/common';

/**
 * Nest's levels in order of increasing detail.
 *
 * The order is the configuration: `LOG_LEVEL` names a point in this list and
 * everything up to it is enabled, so reordering the array changes what
 * production emits without changing any call site.
 */
export const LOG_LEVELS: LogLevel[] = ['error', 'warn', 'log', 'debug', 'verbose'];

/**
 * The levels a given `LOG_LEVEL` enables — cumulative, quietest first.
 *
 * Extracted from `bootstrap()` so it can be pinned by a test: it decides what
 * an operator sees during an incident, and an off-by-one here is invisible
 * until the one night it matters.
 */
export function logLevelsFor(level: LogLevel): LogLevel[] {
  const index = LOG_LEVELS.indexOf(level);
  // An unknown level enables everything rather than nothing: too much output is
  // recoverable, silence is not.
  if (index === -1) return [...LOG_LEVELS];

  return LOG_LEVELS.slice(0, index + 1);
}
