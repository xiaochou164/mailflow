import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  TOOL_PERMISSIONS,
  bearerToken,
  createServer,
  toolError,
} from './index.js';

const ALL_PERMISSIONS = [...new Set(Object.values(TOOL_PERMISSIONS).flat())];

function toolNames(server) {
  return Object.keys(server._registeredTools).sort();
}

test('bearerToken extracts a trimmed bearer token only', () => {
  assert.equal(bearerToken({ headers: { authorization: 'Bearer mf_sk_test' } }), 'mf_sk_test');
  assert.equal(bearerToken({ headers: { authorization: 'bearer   mf_sk_test   ' } }), 'mf_sk_test');
  assert.equal(bearerToken({ headers: { authorization: 'Basic nope' } }), null);
  assert.equal(bearerToken({ headers: {} }), null);
});

test('createServer registers only tools allowed by granted permissions', async () => {
  const server = createServer('mf_sk_token', ['email.search', 'webhook.manage']);

  assert.deepEqual(toolNames(server), [
    'contact_history',
    'create_webhook',
    'delete_webhook',
    'list_webhook_deliveries',
    'list_webhooks',
    'search_email',
    'search_knowledge',
    'similar_emails',
    'test_webhook',
    'update_webhook',
  ]);

  await server.close();
});

test('createServer hides multi-permission tools until every permission is granted', async () => {
  const partial = createServer('mf_sk_token', ['email.thread']);
  assert.equal(toolNames(partial).includes('read_thread'), true);
  assert.equal(toolNames(partial).includes('summarize_thread'), false);
  assert.equal(toolNames(partial).includes('analyze_thread'), false);
  assert.equal(toolNames(partial).includes('daily_email_digest'), false);
  await partial.close();

  const full = createServer('mf_sk_token', ['email.thread', 'email.search', 'ai.summarize']);
  assert.equal(toolNames(full).includes('read_thread'), true);
  assert.equal(toolNames(full).includes('summarize_thread'), true);
  assert.equal(toolNames(full).includes('analyze_thread'), true);
  assert.equal(toolNames(full).includes('daily_email_digest'), true);
  await full.close();
});

test('createServer registers every mapped tool when all permissions are granted', async () => {
  const server = createServer('mf_sk_token', ALL_PERMISSIONS);

  assert.deepEqual(toolNames(server), Object.keys(TOOL_PERMISSIONS).sort());

  await server.close();
});

test('update_webhook sends only supplied fields to the API', async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ webhook: { id: 'wh_1', enabled: false } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    const server = createServer('mf_sk_token', ['webhook.manage']);
    const result = await server._registeredTools.update_webhook.handler({
      webhook_id: '11111111-1111-4111-8111-111111111111',
      name: 'Ops alerts',
      enabled: false,
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'http://backend:3000/api/v1/webhooks/11111111-1111-4111-8111-111111111111');
    assert.equal(calls[0].options.method, 'PATCH');
    assert.equal(calls[0].options.headers.Authorization, 'Bearer mf_sk_token');
    assert.deepEqual(JSON.parse(calls[0].options.body), { name: 'Ops alerts', enabled: false });
    assert.equal(result.isError, undefined);

    await server.close();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('daily_email_digest sends scoped digest options to the API', async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ date: '2026-07-14', summary: 'Digest', emailCount: 3 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    const server = createServer('mf_sk_token', ['email.search', 'ai.summarize']);
    const result = await server._registeredTools.daily_email_digest.handler({
      date: '2026-07-14',
      account_id: '11111111-1111-4111-8111-111111111111',
      folder: 'INBOX',
      limit: 25,
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'http://backend:3000/api/v1/emails/daily-digest');
    assert.equal(calls[0].options.method, 'POST');
    assert.deepEqual(JSON.parse(calls[0].options.body), {
      date: '2026-07-14',
      accountId: '11111111-1111-4111-8111-111111111111',
      folder: 'INBOX',
      limit: 25,
    });
    assert.equal(result.isError, undefined);

    await server.close();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('similar_emails calls the related-message API', async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ emails: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    const server = createServer('mf_sk_token', ['email.search']);
    const result = await server._registeredTools.similar_emails.handler({
      email_id: '11111111-1111-4111-8111-111111111111',
      limit: 12,
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'http://backend:3000/api/v1/emails/11111111-1111-4111-8111-111111111111/similar?limit=12');
    assert.equal(calls[0].options.headers.Authorization, 'Bearer mf_sk_token');
    assert.equal(result.isError, undefined);

    await server.close();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('toolError returns an MCP tool error payload', () => {
  assert.deepEqual(toolError(new Error('boom')), {
    isError: true,
    content: [{ type: 'text', text: 'boom' }],
  });
});
