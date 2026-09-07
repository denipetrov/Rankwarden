/** A non-2xx response from the Blizzard API, with the status preserved. */
export class BlizzardApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly url: string,
    message: string,
    options?: { cause?: unknown; attempts?: number },
  ) {
    super(message, options);
    this.name = 'BlizzardApiError';
    this.attempts = options?.attempts ?? 1;
  }

  /** Requests spent before giving up, retries included. */
  readonly attempts: number;

  /** Characters get renamed, transferred and deleted — 404 is routine, not a failure. */
  get isNotFound(): boolean {
    return this.statusCode === 404;
  }
}
