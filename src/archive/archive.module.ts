import { Module } from '@nestjs/common';

import { BlizzardModule } from '../blizzard/blizzard.module.js';
import { SeasonModule } from '../season/season.module.js';
import { ArchiveRepository } from './archive.repository.js';
import { ArchiveScheduler } from './archive.scheduler.js';
import { ArchiveService } from './archive.service.js';

@Module({
  imports: [BlizzardModule, SeasonModule],
  providers: [ArchiveRepository, ArchiveService, ArchiveScheduler],
  exports: [ArchiveService],
})
export class ArchiveModule {}
