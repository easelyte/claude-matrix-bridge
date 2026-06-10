import { describe, it, expect } from 'vitest';
import { isMcpQuestionAbandoned, MCP_GATE_LIVENESS_MS } from '../lib/mcp-question-gate.js';

// The bridge arms `session.waitingForAnswer = 'mcp:<id>'` while an ask_user MCP
// question is outstanding, so the next chat message is consumed as the answer.
// A bridge-owned timer expires it on timeout, but an early poller death
// (crash/disconnect) would leave the gate armed until that timer fires.
// `isMcpQuestionAbandoned` lets the message handler detect that no poller is
// still waiting and expire the gate now instead of swallowing the message.
describe('isMcpQuestionAbandoned', () => {
  it('treats a question polled just now as live (not abandoned)', () => {
    const now = 1_000_000;
    expect(isMcpQuestionAbandoned({ lastPolledAt: now }, now)).toBe(false);
  });

  it('treats a question polled within the liveness window as live', () => {
    const now = 1_000_000;
    const q = { lastPolledAt: now - (MCP_GATE_LIVENESS_MS - 1) };
    expect(isMcpQuestionAbandoned(q, now)).toBe(false);
  });

  it('treats a question not polled since past the liveness window as abandoned', () => {
    const now = 1_000_000;
    const q = { lastPolledAt: now - (MCP_GATE_LIVENESS_MS + 1) };
    expect(isMcpQuestionAbandoned(q, now)).toBe(true);
  });

  it('treats a question whose poller died minutes ago as abandoned', () => {
    const now = 1_000_000;
    const q = { lastPolledAt: now - 6 * 60_000 };
    expect(isMcpQuestionAbandoned(q, now)).toBe(true);
  });

  it('treats a missing question (already cleaned up / never existed) as abandoned', () => {
    expect(isMcpQuestionAbandoned(undefined, 1_000_000)).toBe(true);
    expect(isMcpQuestionAbandoned(null, 1_000_000)).toBe(true);
  });

  it('treats a question with no lastPolledAt as abandoned (safe default: do not swallow)', () => {
    expect(isMcpQuestionAbandoned({}, 1_000_000)).toBe(true);
  });

  it('honors a custom threshold', () => {
    const now = 1_000_000;
    const q = { lastPolledAt: now - 2000 };
    expect(isMcpQuestionAbandoned(q, now, 1000)).toBe(true);
    expect(isMcpQuestionAbandoned(q, now, 3000)).toBe(false);
  });
});
