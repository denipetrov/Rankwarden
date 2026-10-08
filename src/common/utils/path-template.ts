const PLACEHOLDER = /\{([^{}]*)\}/g;

/** The `{name}` placeholders a path template contains, in order of appearance. */
export function placeholdersIn(template: string): string[] {
  return [...template.matchAll(PLACEHOLDER)].map((match) => match[1] ?? '');
}

/**
 * Fills a configured path template, e.g. `pvp-season/{seasonId}` with
 * `{ seasonId: 42 }`.
 *
 * Values are inserted as given: a caller whose value may hold characters that
 * are not safe in a path encodes it first. A placeholder with no value throws
 * rather than reaching the upstream as a literal `{name}`.
 */
export function fillPath(template: string, values: Record<string, string | number> = {}): string {
  return template.replace(PLACEHOLDER, (_match, name: string) => {
    const value = values[name];
    if (value === undefined) throw new Error(`No value for {${name}} in path "${template}"`);

    return String(value);
  });
}
