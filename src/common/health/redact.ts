/**
 * Removes credentials from anything that might reach a response or a log line.
 *
 * Two distinct leaks are covered. Driver connection errors routinely echo the
 * whole connection string, so any `user:password@` pair in a URI is collapsed to
 * the host. And configured secrets are substituted wherever they appear, since
 * an upstream client is free to quote whatever it was given back at us.
 *
 * The health endpoints are unauthenticated and open on the configured port, so
 * this runs on every string they report rather than only on the ones expected
 * to be risky.
 */
export function redactSecrets(value: string, secrets: readonly string[] = []): string {
  let safe = value.replace(
    /\b([a-z][a-z0-9+.-]*):\/\/[^\s/@]*@/gi,
    (_match, scheme: string) => `${scheme}://***@`,
  );

  for (const secret of secrets) {
    if (secret.length < 4) continue;
    safe = safe.split(secret).join('***');
  }

  return safe;
}

/**
 * The host of a URI, never the URI itself — a Mongo connection string carries
 * its password in userinfo, and an operator only needs to know which host is
 * unreachable.
 */
export function hostOf(uri: string): string {
  try {
    const parsed = new URL(uri);

    return parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
  } catch {
    return 'unknown';
  }
}
