// src/event-hub.ts
import type { SessionEvent } from './events.js';

interface Subscriber {
  queue: SessionEvent[];
  resolve: (() => void) | null;
}

/**
 * Per-session event stream with active-run buffering.
 *
 * - push(event): broadcasts to all subscribers and appends to run buffer if active
 * - subscribe(): returns an AsyncIterable that replays buffered run events then goes live
 * - startRunBuffer(runId): begins buffering events for a run
 * - clearRunBuffer(): clears the buffer (called on run_completed)
 * - close(): signals all subscribers that no more events are coming
 */
export class EventHub {
  private subscribers = new Set<Subscriber>();
  private closed = false;
  private runBuffer: SessionEvent[] | null = null;

  startRunBuffer(_runId: string): void {
    this.runBuffer = [];
  }

  clearRunBuffer(): void {
    this.runBuffer = null;
  }

  push(event: SessionEvent): void {
    if (this.closed) return;

    // Append to run buffer if active
    if (this.runBuffer) {
      this.runBuffer.push(event);
    }

    // Deliver to all live subscribers
    for (const sub of this.subscribers) {
      sub.queue.push(event);
      if (sub.resolve) {
        const r = sub.resolve;
        sub.resolve = null;
        r();
      }
    }
  }

  subscribe(): AsyncIterable<SessionEvent> {
    const hub = this;
    const sub: Subscriber = { queue: [], resolve: null };

    // Replay buffered events if there's an active run
    if (this.runBuffer) {
      sub.queue.push(...this.runBuffer);
    }

    this.subscribers.add(sub);

    return {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<SessionEvent>> {
            while (true) {
              if (sub.queue.length > 0) {
                return { done: false, value: sub.queue.shift()! };
              }
              if (hub.closed) {
                hub.subscribers.delete(sub);
                return { done: true, value: undefined };
              }
              await new Promise<void>(resolve => {
                sub.resolve = resolve;
              });
            }
          },
        };
      },
    };
  }

  close(): void {
    this.closed = true;
    for (const sub of this.subscribers) {
      if (sub.resolve) {
        const r = sub.resolve;
        sub.resolve = null;
        r();
      }
    }
  }
}
