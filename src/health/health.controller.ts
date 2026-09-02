import { Controller, Get } from '@nestjs/common';

import { LeaderboardService } from '../leaderboard/leaderboard.service.js';
import { SeasonService } from '../season/season.service.js';

@Controller('health')
export class HealthController {
  constructor(
    private readonly seasons: SeasonService,
    private readonly leaderboards: LeaderboardService,
  ) {}

  @Get()
  status() {
    return {
      status: 'ok',
      uptimeSeconds: Math.round(process.uptime()),
      sweepRunning: this.leaderboards.isRunning,
      currentSeasons: this.seasons.snapshot(),
    };
  }
}
