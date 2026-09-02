import { Global, Module } from '@nestjs/common';

import { MongoService } from './mongo.service.js';

@Global()
@Module({
  providers: [MongoService],
  exports: [MongoService],
})
export class DatabaseModule {}
