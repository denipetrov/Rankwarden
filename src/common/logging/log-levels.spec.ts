import { describe, expect, it } from 'vitest';
import type { LogLevel } from '@nestjs/common';

import { LOG_LEVELS, logLevelsFor } from './log-levels.js';

/**
 * S10.1 — what each `LOG_LEVEL` actually enables.
 *
 * The slice is cumulative and keyed on array order, so reordering `LOG_LEVELS`
 * silently changes what production emits without touching a single call site.
 * This is the only test that would notice.
 */
describe('logLevelsFor', () => {
  const expected: Record<LogLevel, LogLevel[]> = {
    error: ['error'],
    warn: ['error', 'warn'],
    log: ['error', 'warn', 'log'],
    debug: ['error', 'warn', 'log', 'debug'],
    verbose: ['error', 'warn', 'log', 'debug', 'verbose'],
    fatal: [...LOG_LEVELS],
  };

  for (const [level, levels] of Object.entries(expected) as [LogLevel, LogLevel[]][]) {
    it(`${level} enables ${levels.join(', ')}`, () => {
      expect(logLevelsFor(level)).toEqual(levels);
    });
  }

  it('is cumulative, quietest first', () => {
    // Each level is a prefix of the next. An operator raising the level must
    // only ever gain lines, never trade one set of lines for another.
    for (let index = 1; index < LOG_LEVELS.length; index += 1) {
      const narrower = logLevelsFor(LOG_LEVELS[index - 1]);
      const wider = logLevelsFor(LOG_LEVELS[index]);

      expect(wider.slice(0, narrower.length)).toEqual(narrower);
      expect(wider.length).toBe(narrower.length + 1);
    }
  });

  it('errs towards noise on a level it does not recognise', () => {
    // Too much output is recoverable; a silent process during an incident is not.
    expect(logLevelsFor('nonsense' as LogLevel)).toEqual(LOG_LEVELS);
  });

  it('does not hand out the shared array', () => {
    const levels = logLevelsFor('verbose');
    levels.pop();

    expect(LOG_LEVELS, 'a caller mutating its result must not change the source').toHaveLength(5);
  });
});
