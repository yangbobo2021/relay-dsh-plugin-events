import assert from 'node:assert/strict';
import test from 'node:test';
import { DshInboxAdapter } from '../inbox-adapter.js';

test('EVT-009/010: durable inbox acknowledgement retries reuse the persisted activation message', async () => {
  const agent = { session: { events: [] }, followup(message) {
    this.session.events.push({ type: 'agent/inbox/spliced', data: { inserted: [message] } });
  }, whenIdle() { throw new Error('must not wait for model completion'); } };
  let fail = true;
  const createAdapter = () => new DshInboxAdapter({
    resolveAgent: async () => ({ agent }),
    awaitDurable: async () => { if (fail) throw new Error('flush failed'); },
  });
  const input = { sessionId: 'existing', activationId: 'activation-one', deliveries: [{
    delivery_id: 'd', event_id: 'e', wait_ids: ['w'], event: { body: 'untrusted' },
  }] };
  await assert.rejects(createAdapter().deliver(input), /flush failed/);
  fail = false;
  await createAdapter().deliver(input);
  assert.equal(agent.session.events.length, 1);
  assert.equal(agent.session.events[0].data.inserted[0].id, input.activationId);
  assert.match(agent.session.events[0].data.inserted[0].content[0].text, /untrusted external content/);
  const text = agent.session.events[0].data.inserted[0].content[0].text;
  assert.match(text, /"matched_waits":\[\]/);
  assert.match(text, /"routing_evidence":\[\]/);
});

test('unknown Sessions and oversized Event batches fail before inbox admission', async () => {
  const missing = new DshInboxAdapter({ resolveAgent: async () => ({ error: { message: 'missing' } }), awaitDurable: async () => {} });
  await assert.rejects(missing.deliver({ sessionId: 'missing', activationId: 'a', deliveries: [{}] }), /cannot deliver/);
  const bounded = new DshInboxAdapter({ resolveAgent: async () => ({}), awaitDurable: async () => {}, maxInputChars: 1 });
  assert.throws(() => bounded.buildInput({ sessionId: 's', activationId: 'a', deliveries: [{}] }), /maxInputChars/);
});
