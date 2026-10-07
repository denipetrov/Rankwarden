import { Global, Module } from '@nestjs/common';

import { MongoService } from './mongo.service.js';
import { SchemaService } from './schema/schema.service.js';

@Global()
@Module({
  providers: [MongoService, SchemaService],
  exports: [MongoService, SchemaService],
})
export class DatabaseModule {}
