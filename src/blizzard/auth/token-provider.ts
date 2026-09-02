/**
 * Seam between the HTTP layer and whatever mints Blizzard OAuth tokens.
 * Keeps @denipetrov/blizz-auth out of every consumer's import graph, so the
 * API layer stays unit-testable with a stub provider.
 */
export interface BlizzardTokenProvider {
  getAccessToken(): Promise<string>;
}

export const BLIZZARD_TOKEN_PROVIDER = Symbol('BLIZZARD_TOKEN_PROVIDER');
