import { Module } from '@nestjs/common';

import { RaiderIoHttpService } from './http/raiderio-http.service.js';
import { MythicPlusApi } from './mythic-plus.api.js';

@Module({
  providers: [RaiderIoHttpService, MythicPlusApi],
  exports: [MythicPlusApi, RaiderIoHttpService],
})
export class RaiderIoModule {}
