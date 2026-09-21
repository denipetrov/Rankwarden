import { Module } from '@nestjs/common';

import { MplusSeasonModule } from '../mplus-season/mplus-season.module.js';
import { MplusSpecRepresentationService } from './mplus-spec-representation.service.js';

/**
 * Mythic+ spec representation. Written by the live pass and by the archive, so
 * it depends on neither: both import it.
 */
@Module({
  imports: [MplusSeasonModule],
  providers: [MplusSpecRepresentationService],
  exports: [MplusSpecRepresentationService],
})
export class MplusRepresentationModule {}
