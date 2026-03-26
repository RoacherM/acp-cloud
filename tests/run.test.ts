import { describe, it, expect } from 'vitest';
import { Run } from '../src/run.js';
import type { RunEvent } from '../src/events.js';

// Helper to collect all events from a Run via async iteration
async function collectEvents(run: Run): Promise<RunEvent[]> {
  const events: RunEvent[] = [];
  for await (const event of run) {
    events.push(event);
  }
  return events;
}

describe('Run', () => {
  it('yields events pushed into it', async () => {
    const run = new Run('run-1');

    queueMicrotask(() => {
      run.pushEvent({
        type: 'agent_message_chunk',
        sessionId: 'session-1',
        content: { type: 'text', text: 'hello' },
      });
      run.pushEvent({
        type: 'agent_message_chunk',
        sessionId: 'session-1',
        content: { type: 'text', text: ' world' },
      });
      run.complete('end_turn');
    });

    const events = await collectEvents(run);

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      type: 'agent_message_chunk',
      content: { type: 'text', text: 'hello' },
    });
    expect(events[1]).toMatchObject({
      type: 'agent_message_chunk',
      content: { type: 'text', text: ' world' },
    });
  });

  it('reports status as running then completed', async () => {
    const run = new Run('run-2');

    expect(run.status).toBe('running');
    expect(run.stopReason).toBeNull();

    queueMicrotask(() => {
      run.complete('end_turn');
    });

    await collectEvents(run);

    expect(run.status).toBe('completed');
    expect(run.stopReason).toBe('end_turn');
  });

  it('supports cancel with cancelled stopReason', async () => {
    const run = new Run('run-3');

    queueMicrotask(() => {
      run.pushEvent({
        type: 'usage_update',
        sessionId: 'session-3',
        size: 100,
        used: 10,
      });
      run.complete('cancelled');
    });

    const events = await collectEvents(run);

    expect(events).toHaveLength(1);
    expect(run.status).toBe('completed');
    expect(run.stopReason).toBe('cancelled');
  });

  it('fires listener synchronously when matching event type is pushed', async () => {
    const run = new Run('run-4');
    const captured: RunEvent[] = [];

    run.on('tool_call', (event) => {
      captured.push(event);
    });

    // Push a tool_call event and a non-matching event
    const toolCallEvent: RunEvent = {
      type: 'tool_call',
      sessionId: 'session-4',
      toolCallId: 'tc-1',
      title: 'Read file',
    };
    const otherEvent: RunEvent = {
      type: 'agent_message_chunk',
      sessionId: 'session-4',
      content: { type: 'text', text: 'done' },
    };

    run.pushEvent(toolCallEvent);

    // Listener fires synchronously — captured should already have the event
    expect(captured).toHaveLength(1);
    expect(captured[0]).toBe(toolCallEvent);

    run.pushEvent(otherEvent);

    // Non-matching event should not trigger the tool_call listener
    expect(captured).toHaveLength(1);

    run.complete('end_turn');

    await collectEvents(run);
  });
});
