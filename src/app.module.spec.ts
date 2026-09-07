import { Test } from '@nestjs/testing';
import { beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from './app.module.js';
import { AdminController } from './admin/admin.controller.js';
import { HealthController } from './health/health.controller.js';
import { SeasonTransitionService } from './season/season-transition.service.js';

/**
 * Compiles the whole module graph without initialising it.
 *
 * `compile()` constructs every provider but runs no lifecycle hook, so nothing
 * connects to MongoDB or calls Blizzard — which makes this cheap enough to run
 * on every push while still catching the failures that only appear when the
 * graph is assembled: a provider missing from its module, a service injected
 * across a boundary that does not export it, or a cycle between two modules.
 */
describe('AppModule', () => {
  beforeAll(() => {
    process.env.BLIZZARD_CLIENT_ID ??= 'test-id';
    process.env.BLIZZARD_CLIENT_SECRET ??= 'test-secret';
    process.env.MONGODB_URI ??= 'mongodb://localhost:27017';
  });

  it('resolves every provider and controller', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

    expect(moduleRef.get(HealthController)).toBeInstanceOf(HealthController);
    expect(moduleRef.get(AdminController)).toBeInstanceOf(AdminController);
    // Reads archive and leaderboard collections by name rather than injecting
    // their repositories, because ArchiveModule already imports SeasonModule.
    expect(moduleRef.get(SeasonTransitionService)).toBeInstanceOf(SeasonTransitionService);

    await moduleRef.close();
  });
});
