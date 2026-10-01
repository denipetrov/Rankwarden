import { Module } from '@nestjs/common';

import { RaiderIoHttpService } from './http/raiderio-http.service.js';
import { MythicPlusApi } from './mythic-plus.api.js';
import { RaidingApi } from './raiding.api.js';

@Module({
  providers: [RaiderIoHttpService, MythicPlusApi, RaidingApi],
  exports: [MythicPlusApi, RaidingApi, RaiderIoHttpService],
})
export class RaiderIoModule {}
