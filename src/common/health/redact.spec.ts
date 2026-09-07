import { describe, expect, it } from 'vitest';

import { hostOf, redactSecrets } from './redact.js';

describe('redactSecrets', () => {
  it('strips the credentials out of a connection string', () => {
    // Driver connection errors routinely echo the whole URI, and the health
    // endpoints are unauthenticated.
    const message = redactSecrets(
      'failed to connect to mongodb://admin:hunter2@cluster0.example.net:27017/rankwarden',
    );

    expect(message).not.toContain('hunter2');
    expect(message).not.toContain('admin:');
    expect(message).toContain('cluster0.example.net');
  });

  it('substitutes configured secrets wherever they appear', () => {
    const message = redactSecrets('token request rejected for s3cr3t-value', ['s3cr3t-value']);

    expect(message).toBe('token request rejected for ***');
  });

  it('redacts every occurrence, not only the first', () => {
    expect(redactSecrets('a-secret then a-secret again', ['a-secret'])).toBe('*** then *** again');
  });

  it('ignores secrets too short to be one', () => {
    // Substituting a two-character value would corrupt unrelated text.
    expect(redactSecrets('the quick brown fox', ['ck'])).toBe('the quick brown fox');
  });

  it('leaves a message with nothing sensitive in it alone', () => {
    expect(redactSecrets('Blizzard API 429 for us')).toBe('Blizzard API 429 for us');
  });
});

describe('hostOf', () => {
  it('returns host and port, never the credentials', () => {
    expect(hostOf('mongodb://admin:hunter2@cluster0.example.net:27017/rankwarden')).toBe(
      'cluster0.example.net:27017',
    );
  });

  it('omits the port when there is none', () => {
    expect(hostOf('mongodb+srv://user:pw@cluster0.example.net/db')).toBe('cluster0.example.net');
  });

  it('does not throw on something that is not a URI', () => {
    expect(hostOf('not a uri')).toBe('unknown');
  });
});
