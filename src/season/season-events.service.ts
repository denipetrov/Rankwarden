import { Injectable } from '@nestjs/common';
import { Subject, type Observable } from 'rxjs';

import type { Region } from '../blizzard/blizzard.constants.js';

export type SeasonTransitionKind = 'ended' | 'rollover';

export interface SeasonTransitionEvent {
  kind: SeasonTransitionKind;
  region: Region;
  /** The season now current for the region. */
  seasonId: number;
  /** The season it replaced; equal to `seasonId` for an `ended` event. */
  previousSeasonId: number;
  /** When the new season began, or when the old one ended. */
  at: Date;
  /** True when the change was first seen by comparing against persisted state. */
  acrossRestart: boolean;
}

/**
 * Publishes season transitions so the purge does not have to poll for them.
 *
 * Mirrors `SweepEvents`: a Subject rather than a ReplaySubject, because a
 * subscriber that starts later should act on the persisted state it can read
 * for itself rather than on a replayed event it has already missed reacting to.
 */
@Injectable()
export class SeasonEvents {
  private readonly subject = new Subject<SeasonTransitionEvent>();

  readonly transitions$: Observable<SeasonTransitionEvent> = this.subject.asObservable();

  emit(event: SeasonTransitionEvent): void {
    this.subject.next(event);
  }
}
