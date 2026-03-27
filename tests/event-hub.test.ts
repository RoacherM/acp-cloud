// tests/event-hub.test.ts
import { describe, it, expect } from 'vitest';
import { EventHub } from '../src/event-hub.js';
import type { SessionEvent } from '../src/events.js';

function makeChunkEvent(sessionId: string, text: string, runId?: string): SessionEvent {
  return { type: 'agent_message_chunk', sessionId, runId, content: { type: 'text', text } };
}

// Helper: collect N events from an async iterable
async function collectN(iter: AsyncIterable<SessionEvent>, n: number): Promise<SessionEvent[]> {
  const events: SessionEvent[] = [];
  for await (const event of iter) {
    events.push(event);
    if (events.length >= n) break;
  }
  return events;
}

describe('EventHub', () => {
  it('delivers events to subscriber in order', async () => {
    const hub = new EventHub();
    const sub = hub.subscribe();

    hub.push(makeChunkEvent('s1', 'hello'));
    hub.push(makeChunkEvent('s1', 'world'));
    hub.close();

    const events = await collectN(sub, 2);
    expect(events).toHaveLength(2);
    expect((events[0] as any).content.text).toBe('hello');
    expect((events[1] as any).content.text).toBe('world');
  });

  it('delivers events to multiple subscribers', async () => {
    const hub = new EventHub();
    const sub1 = hub.subscribe();
    const sub2 = hub.subscribe();

    hub.push(makeChunkEvent('s1', 'hello'));
    hub.close();

    const events1 = await collectN(sub1, 1);
    const events2 = await collectN(sub2, 1);
    expect(events1).toHaveLength(1);
    expect(events2).toHaveLength(1);
  });

  it('subscriber sees empty iterable after close with no events', async () => {
    const hub = new EventHub();
    hub.close();
    const sub = hub.subscribe();
    const events: SessionEvent[] = [];
    for await (const e of sub) {
      events.push(e);
    }
    expect(events).toHaveLength(0);
  });

  it('buffers run events and replays to late subscriber', async () => {
    const hub = new EventHub();
    const runStarted: SessionEvent = { type: 'run_started', sessionId: 's1', runId: 'r1' };
    const chunk = makeChunkEvent('s1', 'buffered', 'r1');

    // Start run, push events BEFORE anyone subscribes
    hub.startRunBuffer('r1');
    hub.push(runStarted);
    hub.push(chunk);

    // Now subscribe — should get buffered events
    const sub = hub.subscribe();

    // Push one more live event and close
    const liveChunk = makeChunkEvent('s1', 'live', 'r1');
    hub.push(liveChunk);
    hub.close();

    const events = await collectN(sub, 3);
    expect(events).toHaveLength(3);
    expect(events[0].type).toBe('run_started');
    expect((events[1] as any).content.text).toBe('buffered');
    expect((events[2] as any).content.text).toBe('live');
  });

  it('clears buffer when run completes', async () => {
    const hub = new EventHub();
    hub.startRunBuffer('r1');
    hub.push({ type: 'run_started', sessionId: 's1', runId: 'r1' });
    hub.push(makeChunkEvent('s1', 'during-run', 'r1'));
    hub.clearRunBuffer();

    // Subscribe after buffer cleared — no replay
    const sub = hub.subscribe();
    hub.push(makeChunkEvent('s1', 'after-clear'));
    hub.close();

    const events = await collectN(sub, 1);
    expect(events).toHaveLength(1);
    expect((events[0] as any).content.text).toBe('after-clear');
  });
});
