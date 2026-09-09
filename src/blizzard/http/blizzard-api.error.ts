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

/**
 * A 2xx that carried nothing.
 *
 * Deliberately not a `BlizzardApiError`: the response really was a success by
 * status, so calling it one would contradict that class's own contract and put
 * a 200 into the sweep's failure digest. It is also deliberately not left to
 * surface at the zod boundary, where it would arrive as a `ZodError` and be
 * read as a payload Blizzard shaped wrongly. It is neither — an empty body is a
 * transport symptom, the classic shape of a gateway shedding load, and the
 * callers that separate permanent from transient failure have to see it as one.
 */
export class BlizzardEmptyResponseError extends Error {
  constructor(
    readonly url: string,
    options?: { cause?: unknown },
  ) {
    // The url is carried as a field rather than baked in: `get` appends it and
    // the attempt count to every failure message, and saying it twice reads
    // like two different urls at a glance.
    super('Blizzard API returned an empty response body', options);
    this.name = 'BlizzardEmptyResponseError';
  }
}
