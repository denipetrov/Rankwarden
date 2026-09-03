import { Injectable } from '@nestjs/common';
import { Subject, type Observable } from 'rxjs';

export interface SweepCompleted {
  finishedAt: Date;
  brackets: number;
  failed: number;
}

/**
 * Decouples "a sweep just finished" from whoever reacts to it. Profile
 * enrichment listens so newly discovered characters are picked up immediately
 * instead of waiting out its own interval.
 */
@Injectable()
export class SweepEvents {
  private readonly subject = new Subject<SweepCompleted>();

  readonly completed$: Observable<SweepCompleted> = this.subject.asObservable();

  emitCompleted(event: SweepCompleted): void {
    this.subject.next(event);
  }
}
