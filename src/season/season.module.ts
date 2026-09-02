import { Module } from '@nestjs/common';

import { BlizzardModule } from '../blizzard/blizzard.module.js';
import { SeasonService } from './season.service.js';

@Module({
  imports: [BlizzardModule],
  providers: [SeasonService],
  exports: [SeasonService],
})
export class SeasonModule {}
