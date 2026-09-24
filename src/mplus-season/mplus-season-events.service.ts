import { Injectable } from '@nestjs/common';
import { Subject, type Observable } from 'rxjs';

import type { RaiderIoRegion } from '../raiderio/raiderio.constants.js';

export type MplusSeasonTransitionKind = 'ended' | 'rollover';

export interface MplusSeasonTransitionEvent {
  kind: MplusSeasonTransitionKind;
  region: RaiderIoRegion;
  /** The season now current in the region. */
  season: string;
  /** The season it replaced; equal to `season` for an `ended` event. */
  previousSeason: string;
  /** When the new season began, or when the old one ended. */
  at: Date;
  /** True when the change was first seen by comparing against persisted state. */
  acrossRestart: boolean;
}

/**
 * Publishes Mythic+ season transitions, so the purge does not have to poll for
 * them. The counterpart of `SeasonEvents`, and a Subject rather than a
 * ReplaySubject for the same reason: a subscriber that starts later should act
 * on the persisted state it can read for itself, not on a replayed event.
 */
@Injectable()
export class MplusSeasonEvents {
  private readonly subject = new Subject<MplusSeasonTransitionEvent>();

  readonly transitions$: Observable<MplusSeasonTransitionEvent> = this.subject.asObservable();

  emit(event: MplusSeasonTransitionEvent): void {
    this.subject.next(event);
  }
}
