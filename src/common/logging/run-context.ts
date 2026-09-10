import { AsyncLocalStorage } from 'node:async_hooks';
import { Logger } from '@nestjs/common';

/** The kinds of run that get their own correlation id. */
export type RunKind = 'sweep' | 'enrich' | 'archive' | 'snapshot' | 'transition';

interface RunContext {
  kind: RunKind;
  id: string;
}

const storage = new AsyncLocalStorage<RunContext>();
let counter = 0;

/**
 * A short id, unique within the process, for one run of one job.
 *
 * Deliberately not a uuid: this is read by a human scanning a log, and six
 * characters is enough to tell two sweeps in a day apart while staying short
 * enough to sit on every line without crowding it out.
 */
function nextId(): string {
  counter = (counter + 1) % 46_656; // 36^3, so the counter half stays three chars.

  return Date.now().toString(36).slice(-3) + counter.toString(36).padStart(3, '0');
}

/**
 * Runs `work` under a fresh correlation id. Everything it awaits — including
 * repositories and other services — sees the same id through async local
 * storage, so a line does not have to be threaded a parameter to carry it.
 */
export function withRunId<T>(kind: RunKind, work: (id: string) => Promise<T>): Promise<T> {
  const context: RunContext = { kind, id: nextId() };

  return storage.run(context, () => work(context.id));
}

/** The active run's id, or undefined outside any run. */
export function currentRunId(): string | undefined {
  return storage.getStore()?.id;
}

/**
 * The kind of run in progress, or undefined outside any run.
 *
 * Also what attributes a Blizzard request to the job that made it, for the
 * shared quota: a request issued anywhere inside a sweep — the season refresh
 * it triggers included — is the sweep's, without every call site having to
 * say so.
 */
export function currentRunKind(): RunKind | undefined {
  return storage.getStore()?.kind;
}

/** `[sweep a1b2c3] ` inside a run, an empty string outside one. */
export function runTag(): string {
  const context = storage.getStore();

  return context ? `[${context.kind} ${context.id}] ` : '';
}

/**
 * A `Logger` that stamps every line with the run it belongs to.
 *
 * Nest's context separates services but not runs, so without this there is no
 * way to tie a retry warning to the sweep it came from, or to tell two sweeps
 * apart in a day of logs. Substituted for `Logger` in the services that take
 * part in a run; outside one it behaves exactly like the base class.
 */
export class RunLogger extends Logger {
  override log(message: unknown, ...rest: unknown[]): void {
    super.log(this.stamp(message), ...(rest as []));
  }

  override warn(message: unknown, ...rest: unknown[]): void {
    super.warn(this.stamp(message), ...(rest as []));
  }

  override error(message: unknown, ...rest: unknown[]): void {
    super.error(this.stamp(message), ...(rest as []));
  }

  override debug(message: unknown, ...rest: unknown[]): void {
    super.debug(this.stamp(message), ...(rest as []));
  }

  override verbose(message: unknown, ...rest: unknown[]): void {
    super.verbose(this.stamp(message), ...(rest as []));
  }

  private stamp(message: unknown): unknown {
    const tag = runTag();
    if (!tag) return message;

    return typeof message === 'string' ? `${tag}${message}` : message;
  }
}
