import { Injectable } from '@nestjs/common';
import { Subject, type Observable } from 'rxjs';

export interface SweepCompleted {
  finishedAt: Date;
  brackets: number;
  failed: number;
  /** Characters deleted because they no longer rank in any bracket. */
  removedCharacters: number;
}

/**
 * Decouples "a sweep just finished" from whoever reacts to it. Profile
 * enrichment listens so newly discovered characters are picked up immediately
 * instead of waiting out its own interval.
 */
@Injectable()
export class SweepEvents {
  private readonly subject = new Subject<SweepCompleted>();
  private lastCompleted: SweepCompleted | null = null;

  readonly completed$: Observable<SweepCompleted> = this.subject.asObservable();

  emitCompleted(event: SweepCompleted): void {
    this.lastCompleted = event;
    this.subject.next(event);
  }

  /**
   * The most recent completed sweep, or null if none has finished yet.
   *
   * Retained rather than only published, because the failure nobody notices is
   * the one where both dependencies answer and the data quietly stops moving —
   * health can only report that if it can see when a sweep last landed.
   */
  get last(): SweepCompleted | null {
    return this.lastCompleted;
  }
}
