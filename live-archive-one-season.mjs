// One-off live run: archive a single finished Mythic+ season into the configured
// (development) database, and print samples to cross-reference with raider.io.
const SEASON = process.argv[2] ?? 'season-tww-3';

Object.assign(process.env, {
  LOG_LEVEL: 'log',
  // Every scheduler off: only the work below runs.
  INGEST_RUN_ON_STARTUP: 'false',
  PROFILE_ENRICHMENT_ENABLED: 'false',
  REPRESENTATION_ENABLED: 'false',
  ARCHIVE_ENABLED: 'false',
  SEASON_REFRESH_ENABLED: 'false',
  SEASON_TRANSITION_ENABLED: 'false',
  MPLUS_ENABLED: 'false',
  MPLUS_ARCHIVE_ENABLED: 'false',
  MPLUS_SEASON_REFRESH_ENABLED: 'false',
  MPLUS_TRANSITION_ENABLED: 'false',
});

const { NestFactory } = await import('@nestjs/core');
const { AppModule } = await import('./dist/app.module.js');
const { MongoService } = await import('./dist/database/mongo.service.js');
const { IngestionCoordinator } = await import('./dist/common/ingestion-coordinator.service.js');
const { withRunId } = await import('./dist/common/logging/run-context.js');
const { MplusCatalogueService } = await import('./dist/mplus-season/mplus-catalogue.service.js');
const { MplusCatalogueRepository } = await import(
  './dist/mplus-season/mplus-catalogue.repository.js'
);
const { MplusArchiveService } = await import('./dist/mplus-archive/mplus-archive.service.js');
const { isFinished, regionsOwed } = await import('./dist/mplus-archive/mplus-archive.mapper.js');

const app = await NestFactory.createApplicationContext(AppModule, { logger: ['log', 'error', 'warn'] });
const db = app.get(MongoService).db;
const runs = db.collection('mplus_archive_runs');
const characters = db.collection('mplus_archive_characters');
const out = (label, value) => console.log(`\n### ${label}\n${JSON.stringify(value, null, 2)}`);

try {
  out('database', db.databaseName);
  out('before', {
    catalogueSeasons: await db.collection('mplus_seasons').countDocuments(),
    archiveRuns: await runs.countDocuments({ season: SEASON }),
    archiveCharacters: await characters.countDocuments({ season: SEASON }),
    liveRuns: await db.collection('mplus_runs').countDocuments(),
  });

  const refresh = await withRunId('mplus-season', () => app.get(MplusCatalogueService).refreshIfDue());
  out('catalogue', refresh);

  const season = (await app.get(MplusCatalogueRepository).allSeasons()).find((s) => s.slug === SEASON);
  if (!season) throw new Error(`${SEASON} is not in the catalogue`);
  if (!isFinished(season, new Date())) throw new Error(`${SEASON} has not finished in every region`);
  const regions = (process.env.RAIDERIO_REGIONS ?? 'us,eu,kr,tw,cn').split(',');
  if (regionsOwed(season, regions).length === 0) throw new Error(`${SEASON} is already archived in every region`);

  const archive = app.get(MplusArchiveService);
  const startedAt = Date.now();
  const result = await withRunId('mplus-archive', () =>
    app.get(IngestionCoordinator).duringMplusArchive(() => archive.archiveSeason(season)),
  );
  out('result', { ...result, seconds: Math.round((Date.now() - startedAt) / 1000) });

  const marker = (await db.collection('mplus_seasons').findOne({ slug: SEASON }))?.archive;
  out('marker', marker);

  out('stored', {
    runs: await runs.countDocuments({ season: SEASON }),
    characters: await characters.countDocuments({ season: SEASON }),
    runsByRegion: await runs
      .aggregate([{ $match: { season: SEASON } }, { $group: { _id: '$region', runs: { $sum: 1 } } }, { $sort: { runs: -1 } }])
      .toArray(),
    rankRange: await runs
      .aggregate([{ $match: { season: SEASON } }, { $group: { _id: null, min: { $min: '$rank' }, max: { $max: '$rank' }, topScore: { $max: '$score' }, lowScore: { $min: '$score' } } }])
      .toArray(),
  });

  const topRuns = await runs.find({ season: SEASON }).sort({ score: -1 }).limit(5).toArray();
  out(
    'top 5 runs by score (each region ranks its own board)',
    {
      leaderboard: `https://raider.io/mythic-plus-rankings/${SEASON}/all/<region>/leaderboards`,
      runs: topRuns.map((run) => ({
        rank: run.rank,
        score: run.score,
        dungeon: run.dungeon.name,
        level: run.mythicLevel,
        clearTime: `${Math.floor(run.clearTimeMs / 60000)}m${String(Math.floor((run.clearTimeMs % 60000) / 1000)).padStart(2, '0')}s`,
        chests: run.numChests,
        completedAt: run.completedAt,
        region: run.region,
        keystoneRunId: run.keystoneRunId,
        url: `https://raider.io/mythic-plus-runs/${SEASON}/${run.keystoneRunId}-${run.mythicLevel}-${run.dungeon.slug}`,
        roster: run.roster.map((member) => `${member.characterName}-${member.realmSlug} (${member.specName ?? '?'} ${member.className})`),
      })),
    },
  );

  const topCharacters = await characters.find({ season: SEASON }).sort({ mythicScore: -1 }).limit(5).toArray();
  out(
    'top 5 characters by archived score (score is over the region top 2,000 runs only)',
    topCharacters.map((character) => ({
      key: character.key,
      mythicScore: character.mythicScore,
      dungeonsCovered: character.dungeonsCovered,
      profile: `https://raider.io/characters/${character.region}/${character.realmSlug}/${encodeURIComponent(character.characterName)}?season=${SEASON}`,
      bestRuns: character.dungeonRuns.map((entry) => `${entry.dungeon.name} +${entry.mythicLevel} ${entry.score}`),
    })),
  );
} finally {
  await app.close();
}
