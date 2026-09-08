import type { INestApplication } from '@nestjs/common';

import { ArchiveScheduler } from '../../src/archive/archive.scheduler.js';
import { LeaderboardScheduler } from '../../src/leaderboard/leaderboard.scheduler.js';
import { ProfileScheduler } from '../../src/profile/profile.scheduler.js';
import { SpecRepresentationScheduler } from '../../src/representation/spec-representation.scheduler.js';
import { SeasonScheduler } from '../../src/season/season.scheduler.js';
import { SeasonTransitionScheduler } from '../../src/season/season-transition.scheduler.js';

interface Settleable {
  whenSettled(): Promise<void>;
}

/**
 * Every scheduler that starts work it cannot await.
 *
 * Listed in one place so `settle()` covers all of them: a scheduler added later
 * without a `whenSettled` seam should fail typecheck here rather than show up
 * as an intermittent failure somewhere unrelated.
 */
export function schedulerSeams(app: INestApplication): Settleable[] {
  return [
    LeaderboardScheduler,
    ProfileScheduler,
    SpecRepresentationScheduler,
    ArchiveScheduler,
    SeasonScheduler,
    SeasonTransitionScheduler,
  ].map((type) => app.get<Settleable>(type));
}
