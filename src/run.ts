import type { RunEvent, StopReason } from './events.js';

export class Run implements AsyncIterable<RunEvent> {
  readonly id: string;

  private eventQueue: RunEvent[] = [];
  private done = false;
  private _status: 'queued' | 'running' | 'completed' = 'running';
  private _stopReason: StopReason | null = null;
  private resolve: (() => void) | null = null;
  private listeners: Map<string, Array<(data: any) => void>> = new Map();

  constructor(id: string) {
    this.id = id;
  }

  get status(): 'queued' | 'running' | 'completed' {
    return this._status;
  }

  get stopReason(): StopReason | null {
    return this._stopReason;
  }

  /**
   * Called by Session to push events into the stream.
   * Fires any registered listeners synchronously before queueing.
   */
  pushEvent(event: RunEvent): void {
    const typeListeners = this.listeners.get(event.type);
    if (typeListeners) {
      for (const listener of typeListeners) {
        listener(event);
      }
    }

    this.eventQueue.push(event);

    if (this.resolve) {
      const r = this.resolve;
      this.resolve = null;
      r();
    }
  }

  /**
   * Called by Session when the prompt turn completes.
   */
  complete(stopReason: StopReason): void {
    this._stopReason = stopReason;
    this._status = 'completed';
    this.done = true;

    if (this.resolve) {
      const r = this.resolve;
      this.resolve = null;
      r();
    }
  }

  /**
   * Register an event listener for a specific event type.
   * Listeners fire synchronously when pushEvent is called.
   */
  on(eventType: string, listener: (data: any) => void): void {
    if (!this.listeners.has(eventType)) {
      this.listeners.set(eventType, []);
    }
    this.listeners.get(eventType)!.push(listener);
  }

  async *[Symbol.asyncIterator](): AsyncIterator<RunEvent> {
    while (true) {
      while (this.eventQueue.length > 0) {
        yield this.eventQueue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>(resolve => {
        this.resolve = resolve;
      });
    }
  }
}
