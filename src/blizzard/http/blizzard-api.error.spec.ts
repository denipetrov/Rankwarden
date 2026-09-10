import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';

import { BlizzardApiError, BlizzardEmptyResponseError } from './blizzard-api.error.js';

describe('BlizzardApiError', () => {
  it('preserves the status and treats 404 as routine', () => {
    // Enrichment keys "this character no longer exists" off `isNotFound`, and a
    // credential failure mislabelled as a 404 would blank thousands of profiles.
    expect(new BlizzardApiError(404, '/x', 'gone').isNotFound).toBe(true);
    expect(new BlizzardApiError(403, '/x', 'denied').isNotFound).toBe(false);
    expect(new BlizzardApiError(429, '/x', 'slow down').statusCode).toBe(429);
  });

  it('defaults to a single attempt when none is given', () => {
    expect(new BlizzardApiError(500, '/x', 'boom').attempts).toBe(1);
    expect(new BlizzardApiError(500, '/x', 'boom', { attempts: 4 }).attempts).toBe(4);
  });
});

describe('BlizzardEmptyResponseError', () => {
  it('is not a BlizzardApiError', () => {
    // The response really was a 2xx, so calling it an API error would
    // contradict that class and put a 200 into the sweep's failure digest,
    // where the digest reports "no HTTP status" instead.
    const error = new BlizzardEmptyResponseError('/data/wow/pvp-season/index');

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(BlizzardApiError);
  });

  it('is not a ZodError, which is what decides permanence', () => {
    // The whole point of the class. Left to surface at the zod boundary, an
    // empty body arrives as a ZodError, and enrichment reads that as
    // deterministic — parking the character for the full TTL when a gateway
    // blip should have been retried within the backoff.
    const error = new BlizzardEmptyResponseError('/x');

    expect(error).not.toBeInstanceOf(ZodError);
  });

  it('names the condition without repeating the url', () => {
    // `BlizzardHttpService.get` appends the url and attempt count to every
    // failure message; baking it in too reads like two different urls.
    const error = new BlizzardEmptyResponseError('/data/wow/pvp-season/index');

    expect(error.message).toBe('Blizzard API returned an empty response body');
    expect(error.url).toBe('/data/wow/pvp-season/index');
    expect(error.name).toBe('BlizzardEmptyResponseError');
  });
});
