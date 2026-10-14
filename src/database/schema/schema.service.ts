import { Injectable, Logger } from '@nestjs/common';
import type { IndexDescription } from 'mongodb';

import { MongoService } from '../mongo.service.js';
import { DATABASE_SCHEMA, type CollectionSchema } from './schema.definition.js';

export interface SchemaReport {
  collections: number;
  collectionsCreated: string[];
  indexes: number;
  retiredIndexesDropped: string[];
}

/** MongoDB's "a collection with this name already exists". */
const NAMESPACE_EXISTS = 48;

/**
 * Brings a database to the declared structure, or checks that it is there.
 *
 * Two operations, kept apart because in production two different actors
 * perform them. `apply` changes the database and is run by the deploy step,
 * with a user allowed to create collections and indexes. `verify` only reads,
 * and is what the running service does at startup: its own user can read and
 * write documents and nothing else, so a restart can never alter the
 * structure — it can only notice that the deploy step was skipped.
 */
@Injectable()
export class SchemaService {
  private readonly logger = new Logger(SchemaService.name);

  constructor(private readonly mongo: MongoService) {}

  /**
   * Creates what is missing and drops what was retired. Structure only: it
   * never reads or changes a document. Safe to run repeatedly: on a database
   * already in shape every step is a no-op.
   */
  async apply(): Promise<SchemaReport> {
    const db = this.mongo.db;
    const existing = await this.existingCollections();
    const report: SchemaReport = {
      collections: DATABASE_SCHEMA.length,
      collectionsCreated: [],
      indexes: 0,
      retiredIndexesDropped: [],
    };

    for (const definition of DATABASE_SCHEMA) {
      const { collection: name, indexes } = definition;

      if (!existing.has(name)) {
        // Explicit, rather than left to the first insert, so that `verify`
        // can tell a database the schema step has been through from one where
        // a collection merely came into being.
        await db.createCollection(name).catch((error: unknown) => {
          if ((error as { code?: number }).code !== NAMESPACE_EXISTS) throw error;
        });
        report.collectionsCreated.push(name);
      }

      if (indexes.length > 0) {
        await db.collection(name).createIndexes([...indexes]);
        report.indexes += indexes.length;
      }

      // After the build, never before: a retired index is only dropped once
      // its replacement exists, so no query is ever left without one.
      for (const retired of await this.retiredIndexesOn(definition)) {
        await db.collection(name).dropIndex(retired);
        report.retiredIndexesDropped.push(`${name}.${retired}`);
        this.logger.log(`Dropped retired index "${retired}" on "${name}"`);
      }
    }

    this.logger.log(
      `Database schema applied: ${report.collections} collections ` +
        `(${report.collectionsCreated.length} created), ${report.indexes} indexes ensured, ` +
        `${report.retiredIndexesDropped.length} retired index(es) dropped`,
    );

    return report;
  }

  /**
   * Everything that separates this database from the declared structure, as
   * readable lines. Empty means ready. Changes nothing.
   *
   * An index the declaration does not mention is left alone and not reported:
   * an operator may add one to investigate a slow query, and that must not
   * stop the service from starting.
   */
  async verify(): Promise<string[]> {
    const existing = await this.existingCollections();
    const problems: string[] = [];

    for (const definition of DATABASE_SCHEMA) {
      const { collection: name, indexes } = definition;

      if (!existing.has(name)) {
        problems.push(`collection "${name}" does not exist`);
        continue;
      }

      const stored = new Map(
        (await this.mongo.db.collection(name).indexes()).map((index) => [index.name, index]),
      );

      for (const declared of indexes) {
        const actual = stored.get(declared.name);

        if (!actual) {
          problems.push(`index "${declared.name}" on "${name}" is missing`);
          continue;
        }

        const difference = describeDifference(declared, actual);
        if (difference) problems.push(`index "${declared.name}" on "${name}" ${difference}`);
      }

      for (const retired of await this.retiredIndexesOn(definition)) {
        problems.push(`retired index "${retired}" on "${name}" has not been dropped`);
      }
    }

    return problems;
  }

  private async existingCollections(): Promise<Set<string>> {
    const collections = await this.mongo.db.listCollections({}, { nameOnly: true }).toArray();

    return new Set(collections.map((collection) => collection.name));
  }

  private async retiredIndexesOn(definition: CollectionSchema): Promise<string[]> {
    const { collection, retiredIndexes, retiredIndexPattern } = definition;
    if (!retiredIndexes && !retiredIndexPattern) return [];

    const names = (await this.mongo.db.collection(collection).indexes()).map(
      (index) => index.name ?? '',
    );

    return names.filter(
      (name) => retiredIndexes?.has(name) || (retiredIndexPattern?.test(name) ?? false),
    );
  }
}

/**
 * How a stored index departs from its declaration, or null when it matches.
 *
 * Key order is compared, not just key membership: `{ a: 1, b: 1 }` and
 * `{ b: 1, a: 1 }` serve different queries.
 */
function describeDifference(
  declared: IndexDescription,
  actual: { key: unknown; unique?: boolean },
): string | null {
  const declaredKey = JSON.stringify(declared.key);
  const actualKey = JSON.stringify(actual.key);

  if (declaredKey !== actualKey) return `has key ${actualKey}, declared as ${declaredKey}`;

  if (Boolean(declared.unique) !== Boolean(actual.unique)) {
    return declared.unique ? 'is not unique, declared unique' : 'is unique, declared non-unique';
  }

  return null;
}
