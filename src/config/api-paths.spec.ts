import { describe, expect, it, vi } from 'vitest';

import { ProfileApi } from '../blizzard/profile.api.js';
import { PvpApi } from '../blizzard/pvp.api.js';
import { MythicPlusApi } from '../raiderio/mythic-plus.api.js';
import { RaidingApi } from '../raiderio/raiding.api.js';
import { validateEnv, type Env } from './env.schema.js';

const base = {
  BLIZZARD_CLIENT_ID: 'id',
  BLIZZARD_CLIENT_SECRET: 'secret',
  MONGODB_URI: 'mongodb://localhost:27017',
};

/** The four API classes over a recording transport, configured as `overrides` say. */
function build(overrides: Record<string, string> = {}) {
  const env = validateEnv({ ...base, ...overrides });
  const config = { get: (key: keyof Env) => env[key] } as never;
  // Resolves to nothing, so every call fails at parsing — after the request
  // has been made, which is all these tests look at.
  const blizzard = vi.fn().mockResolvedValue(undefined);
  const raiderIo = vi.fn().mockResolvedValue(undefined);

  return {
    pvp: new PvpApi({ get: blizzard } as never, config),
    profile: new ProfileApi({ get: blizzard } as never, config),
    mythicPlus: new MythicPlusApi({ get: raiderIo } as never, config),
    raiding: new RaidingApi({ get: raiderIo } as never, config),
    blizzardPaths: () => blizzard.mock.calls.map((call) => call[1] as string),
    raiderIoPaths: () => raiderIo.mock.calls.map((call) => call[0] as string),
  };
}

const attempt = (call: Promise<unknown>) => call.catch(() => undefined);

describe('upstream endpoint paths', () => {
  it('asks Blizzard for exactly the paths it serves today when nothing is configured', async () => {
    const apis = build();

    await attempt(apis.pvp.getSeasonIndex('us'));
    await attempt(apis.pvp.getSeason('us', 42));
    await attempt(apis.pvp.getBrackets('us', 42));
    await attempt(apis.pvp.getLeaderboard('us', 42, '3v3'));
    await attempt(apis.pvp.getSeasonRewards('us', 42));
    await attempt(apis.pvp.getSpecialization('us', 72));
    await attempt(apis.profile.getProfile('eu', 'tarren-mill', 'Zëph'));
    await attempt(apis.profile.getSpecializations('eu', 'tarren-mill', 'Zëph'));

    expect(apis.blizzardPaths()).toEqual([
      'data/wow/pvp-season/index',
      'data/wow/pvp-season/42',
      'data/wow/pvp-season/42/pvp-leaderboard/index',
      'data/wow/pvp-season/42/pvp-leaderboard/3v3',
      'data/wow/pvp-season/42/pvp-reward/index',
      'data/wow/playable-specialization/72',
      'profile/wow/character/tarren-mill/z%C3%ABph',
      'profile/wow/character/tarren-mill/z%C3%ABph/specializations',
    ]);
  });

  it('asks Raider.io for exactly the paths it serves today when nothing is configured', async () => {
    const apis = build();

    await attempt(apis.mythicPlus.getRunsPage('season-mn-1', 'us', 0));
    await attempt(apis.mythicPlus.getSeasonCutoffs('season-mn-1', 'us'));
    await attempt(apis.mythicPlus.getStaticData(11));
    await attempt(apis.raiding.getStaticData(11));
    await attempt(apis.raiding.getRaidRankingsPage('some-raid', 'world', 'mythic', 0));

    expect(apis.raiderIoPaths()).toEqual([
      'mythic-plus/runs',
      'mythic-plus/season-cutoffs',
      'mythic-plus/static-data',
      'raiding/static-data',
      'raiding/raid-rankings',
    ]);
  });

  it('follows a path changed in configuration, with no code change', async () => {
    const apis = build({
      BLIZZARD_PATH_PVP_LEADERBOARD: 'data/wow/v2/season/{seasonId}/ladder/{bracket}',
      BLIZZARD_PATH_CHARACTER_PROFILE: 'profile/wow/v2/{realmSlug}/characters/{characterName}',
      RAIDERIO_PATH_MPLUS_RUNS: 'mythic-plus/v2/runs',
    });

    await attempt(apis.pvp.getLeaderboard('us', 42, '3v3'));
    await attempt(apis.profile.getProfile('eu', 'tarren-mill', 'Zëph'));
    await attempt(apis.mythicPlus.getRunsPage('season-mn-1', 'us', 0));

    expect(apis.blizzardPaths()).toEqual([
      'data/wow/v2/season/42/ladder/3v3',
      'profile/wow/v2/tarren-mill/characters/z%C3%ABph',
    ]);
    expect(apis.raiderIoPaths()).toEqual(['mythic-plus/v2/runs']);
  });
});
