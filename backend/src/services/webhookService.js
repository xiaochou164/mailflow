import { createHmac, randomBytes } from 'node:crypto';
import { query } from './db.js';
import { decrypt, encrypt } from './encryption.js';
import { safeFetch } from './safeFetch.js';

export const WEBHOOK_EVENTS = Object.freeze([
  'email.received',
  'email.updated',
  'email.sent',
  'email.deleted',
  'attachment.received',
  'webhook.test',
]);

const RETRY_DELAYS_SECONDS = [60, 300, 1800, 7200, 43200];
let workerTimer = null;
let workerBusy = false;

function normalizeEvents(events) {
  if (!Array.isArray(events) || !events.length) {
    throw Object.assign(new Error('At least one webhook event is required'), { status: 400 });
  }
  const unique = [...new Set(events)];
  if (unique.some(event => !WEBHOOK_EVENTS.includes(event) || event === 'webhook.test')) {
    throw Object.assign(new Error('Unknown webhook event'), { status: 400 });
  }
  return unique;
}

function normalizeUrl(value) {
  let parsed;
  try { parsed = new URL(String(value || '')); } catch {
    throw Object.assign(new Error('Invalid webhook URL'), { status: 400 });
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw Object.assign(new Error('Webhook URL must use http or https'), { status: 400 });
  }
  if (parsed.username || parsed.password) {
    throw Object.assign(new Error('Webhook URL must not include credentials'), { status: 400 });
  }
  return parsed.toString();
}

function serializeWebhook(row) {
  return {
    id: row.id,
    applicationId: row.application_id,
    name: row.name,
    url: row.url,
    events: row.events || [],
    enabled: row.enabled,
    createdAt: row.created_at,
    lastDeliveryAt: row.last_delivery_at,
    lastSuccessAt: row.last_success_at,
    lastError: row.last_error,
  };
}

export async function listWebhooks(userId) {
  const result = await query('SELECT * FROM webhooks WHERE user_id = $1 ORDER BY created_at DESC', [userId]);
  return result.rows.map(serializeWebhook);
}

export async function createWebhook({ userId, applicationId = null, name, url, events }) {
  const normalizedName = String(name || '').trim().slice(0, 100);
  if (!normalizedName) throw Object.assign(new Error('Webhook name is required'), { status: 400 });
  const normalizedUrl = normalizeUrl(url);
  const normalizedEvents = normalizeEvents(events);
  if (applicationId) {
    const owner = await query('SELECT id FROM applications WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL', [applicationId, userId]);
    if (!owner.rows.length) throw Object.assign(new Error('Application not found'), { status: 404 });
  }
  const secret = `whsec_${randomBytes(32).toString('base64url')}`;
  const result = await query(`
    INSERT INTO webhooks (user_id, application_id, name, url, secret_encrypted, events)
    VALUES ($1, $2, $3, $4, $5, $6::text[])
    RETURNING *
  `, [userId, applicationId, normalizedName, normalizedUrl, encrypt(secret), normalizedEvents]);
  return { webhook: serializeWebhook(result.rows[0]), secret };
}

export async function updateWebhook({ userId, webhookId, enabled, events, name, url }) {
  const current = await query('SELECT * FROM webhooks WHERE id = $1 AND user_id = $2', [webhookId, userId]);
  if (!current.rows.length) throw Object.assign(new Error('Webhook not found'), { status: 404 });
  const row = current.rows[0];
  const result = await query(`
    UPDATE webhooks SET name = $1, url = $2, events = $3::text[], enabled = $4,
      updated_at = NOW(), last_error = CASE WHEN $4 THEN last_error ELSE NULL END
    WHERE id = $5 AND user_id = $6 RETURNING *
  `, [
    name === undefined ? row.name : String(name).trim().slice(0, 100),
    url === undefined ? row.url : normalizeUrl(url),
    events === undefined ? row.events : normalizeEvents(events),
    enabled === undefined ? row.enabled : enabled === true,
    webhookId,
    userId,
  ]);
  return serializeWebhook(result.rows[0]);
}

export async function deleteWebhook({ userId, webhookId }) {
  const result = await query('DELETE FROM webhooks WHERE id = $1 AND user_id = $2 RETURNING id', [webhookId, userId]);
  return result.rows.length > 0;
}

export async function listWebhookDeliveries({ userId, webhookId, limit = 50 }) {
  const result = await query(`
    SELECT d.id, d.event, d.status, d.attempt_count, d.response_status,
           d.error, d.created_at, d.delivered_at, d.next_attempt_at
    FROM webhook_deliveries d
    JOIN webhooks w ON w.id = d.webhook_id
    WHERE w.user_id = $1 AND d.webhook_id = $2
    ORDER BY d.created_at DESC LIMIT $3
  `, [userId, webhookId, Math.max(1, Math.min(Number(limit) || 50, 200))]);
  return result.rows.map(row => ({
    id: row.id, event: row.event, status: row.status, attemptCount: row.attempt_count,
    responseStatus: row.response_status, error: row.error, createdAt: row.created_at,
    deliveredAt: row.delivered_at, nextAttemptAt: row.next_attempt_at,
  }));
}

export async function enqueueWebhookEvent({ userId, event, payload }) {
  if (!WEBHOOK_EVENTS.includes(event)) throw new Error(`Unsupported webhook event: ${event}`);
  const result = await query(`
    INSERT INTO webhook_deliveries (webhook_id, event, payload)
    SELECT id, $2::text, $3::jsonb FROM webhooks
    WHERE user_id = $1 AND enabled = true AND $2::text = ANY(events)
    RETURNING id
  `, [userId, event, JSON.stringify(payload || {})]);
  return result.rows.length;
}

export async function enqueueWebhookTest({ userId, webhookId }) {
  const result = await query(`
    INSERT INTO webhook_deliveries (webhook_id, event, payload)
    SELECT id, 'webhook.test', $3::jsonb FROM webhooks
    WHERE id = $1 AND user_id = $2 AND enabled = true
    RETURNING id
  `, [webhookId, userId, JSON.stringify({ message: 'MailFlow webhook test', generatedAt: new Date().toISOString() })]);
  if (!result.rows.length) throw Object.assign(new Error('Webhook not found or disabled'), { status: 404 });
  return result.rows[0].id;
}

async function claimDelivery() {
  const result = await query(`
    WITH candidate AS (
      SELECT d.id FROM webhook_deliveries d
      JOIN webhooks w ON w.id = d.webhook_id
      WHERE w.enabled = true
        AND ((d.status = 'pending' AND d.next_attempt_at <= NOW())
          OR (d.status = 'delivering' AND d.updated_at < NOW() - INTERVAL '5 minutes'))
      ORDER BY d.next_attempt_at, d.created_at
      FOR UPDATE OF d SKIP LOCKED LIMIT 1
    )
    UPDATE webhook_deliveries d SET status = 'delivering', attempt_count = attempt_count + 1, updated_at = NOW()
    FROM candidate c, webhooks w
    WHERE d.id = c.id AND w.id = d.webhook_id
    RETURNING d.*, w.url, w.secret_encrypted, w.user_id
  `);
  return result.rows[0] || null;
}

async function deliver(row) {
  const body = JSON.stringify({ id: row.id, event: row.event, createdAt: row.created_at, data: row.payload });
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const secret = decrypt(row.secret_encrypted);
  if (!secret) throw new Error('Webhook signing secret cannot be decrypted');
  const signature = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  const allowPrivate = process.env.WEBHOOK_ALLOW_PRIVATE_HOSTS === 'true';
  const response = await safeFetch(row.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'MailFlow-Webhooks/1.0',
      'X-MailFlow-Event': row.event,
      'X-MailFlow-Delivery': row.id,
      'X-MailFlow-Timestamp': timestamp,
      'X-MailFlow-Signature': `v1=${signature}`,
    },
    body,
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  }, { allowPrivate, requireHttps: !allowPrivate });
  const responseBody = (await response.text()).slice(0, 2000);
  if (!response.ok) throw Object.assign(new Error(`Webhook returned HTTP ${response.status}`), { responseStatus: response.status, responseBody });
  await query(`
    UPDATE webhook_deliveries SET status = 'succeeded', response_status = $1,
      response_body = $2, error = NULL, delivered_at = NOW(), updated_at = NOW()
    WHERE id = $3
  `, [response.status, responseBody, row.id]);
  await query(`UPDATE webhooks SET last_delivery_at = NOW(), last_success_at = NOW(), last_error = NULL WHERE id = $1`, [row.webhook_id]);
}

async function markFailure(row, err) {
  const attempt = Number(row.attempt_count);
  const retryDelay = RETRY_DELAYS_SECONDS[attempt - 1];
  const terminal = retryDelay === undefined;
  await query(`
    UPDATE webhook_deliveries SET status = $1, response_status = $2,
      response_body = $3, error = $4,
      next_attempt_at = CASE WHEN $5::int IS NULL THEN next_attempt_at ELSE NOW() + ($5 * INTERVAL '1 second') END,
      updated_at = NOW()
    WHERE id = $6
  `, [terminal ? 'failed' : 'pending', err.responseStatus || null, err.responseBody || null, String(err.message || 'Delivery failed').slice(0, 1000), retryDelay ?? null, row.id]);
  await query('UPDATE webhooks SET last_delivery_at = NOW(), last_error = $1 WHERE id = $2', [String(err.message || 'Delivery failed').slice(0, 1000), row.webhook_id]);
}

export async function processWebhookQueueOnce() {
  const row = await claimDelivery();
  if (!row) return false;
  try { await deliver(row); } catch (err) { await markFailure(row, err); }
  return true;
}

export function startWebhookWorker() {
  if (workerTimer) return;
  const tick = async () => {
    if (workerBusy) return;
    workerBusy = true;
    try {
      for (let i = 0; i < 10; i++) {
        if (!await processWebhookQueueOnce()) break;
      }
    } catch (err) {
      console.error('Webhook worker error:', err.message);
    } finally {
      workerBusy = false;
    }
  };
  workerTimer = setInterval(tick, 5000);
  workerTimer.unref?.();
  setImmediate(tick);
}
