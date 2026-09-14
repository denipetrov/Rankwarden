/** A non-2xx response from the Raider.io API, with the status preserved. */
export class RaiderIoApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly url: string,
    message: string,
    options?: { cause?: unknown; attempts?: number },
  ) {
    super(message, options);
    this.name = 'RaiderIoApiError';
    this.attempts = options?.attempts ?? 1;
  }

  /** Requests spent before giving up, retries included. */
  readonly attempts: number;

  /** A season or dungeon Raider.io does not serve — routine, not a failure. */
  get isNotFound(): boolean {
    return this.statusCode === 404;
  }

  /**
   * A malformed request, which for this client means an out-of-range `page`.
   *
   * Worth separating from the other 4xx: the runs endpoint answers 400 rather
   * than an empty page once the caller walks past the last page it will serve,
   * so a pass that hits one has reached the end of the data, not an error.
   */
  get isBadRequest(): boolean {
    return this.statusCode === 400;
  }
}

/**
 * A 2xx that carried nothing.
 *
 * The same trap `BlizzardEmptyResponseError` exists for, for the same reason:
 * `got` resolves an empty body to `''` rather than raising, so without an
 * explicit check the emptiness travels up and only fails at the zod boundary —
 * where it is indistinguishable from Raider.io reshaping a payload, and gets
 * classified as permanent. Raider.io sits behind Cloudflare, which is exactly
 * the kind of front that answers 200-with-nothing while shedding load.
 */
export class RaiderIoEmptyResponseError extends Error {
  constructor(
    readonly url: string,
    options?: { cause?: unknown },
  ) {
    super('Raider.io API returned an empty response body', options);
    this.name = 'RaiderIoEmptyResponseError';
  }
}
