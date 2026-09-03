import { Module } from '@nestjs/common';

import { BlizzardTokenService } from './auth/blizzard-token.service.js';
import { BLIZZARD_TOKEN_PROVIDER } from './auth/token-provider.js';
import { BlizzardHttpService } from './http/blizzard-http.service.js';
import { ProfileApi } from './profile.api.js';
import { PvpApi } from './pvp.api.js';

@Module({
  providers: [
    { provide: BLIZZARD_TOKEN_PROVIDER, useClass: BlizzardTokenService },
    BlizzardHttpService,
    PvpApi,
    ProfileApi,
  ],
  exports: [PvpApi, ProfileApi, BLIZZARD_TOKEN_PROVIDER],
})
export class BlizzardModule {}
