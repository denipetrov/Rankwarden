import { Global, Module } from '@nestjs/common';

import { HiddenController } from './hidden.controller.js';
import { HiddenRegistry } from './hidden.registry.js';

/** Global: the repositories that write characters and guilds all consult it. */
@Global()
@Module({
  controllers: [HiddenController],
  providers: [HiddenRegistry],
  exports: [HiddenRegistry],
})
export class HiddenModule {}
