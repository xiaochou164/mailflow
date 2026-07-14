import { Router } from 'express';
import {
  applicationRateLimit,
  requireApplication,
  requireApplicationPermission,
} from '../middleware/applicationAuth.js';
import { getEmailForApplication } from '../services/emailReadService.js';
import { searchMessages } from '../services/searchService.js';
import draftRoutes from './draft.js';
import mailRoutes from './mail.js';
import sendRoutes from './send.js';
import {
  getAttachmentForApplication,
  getThreadForApplication,
  listAccountsForApplication,
} from '../services/applicationMailService.js';
import {
  WEBHOOK_EVENTS,
  createWebhook,
  deleteWebhook,
  enqueueWebhookTest,
  listWebhookDeliveries,
  listWebhooks,
  updateWebhook,
} from '../services/webhookService.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const router = Router();

function delegateTo(routerToUse, target) {
  return (req, res, next) => {
    req.session.userId = req.application.userId;
    req.url = typeof target === 'function' ? target(req) : target;
    delete req._parsedUrl;
    routerToUse.handle(req, res, next);
  };
}

async function applicationWebhook(req, webhookId) {
  const webhooks = await listWebhooks(req.application.userId);
  return webhooks.find(webhook => webhook.id === webhookId && webhook.applicationId === req.application.id) || null;
}

function serializeSearchResult(message) {
  return {
    id: message.id,
    threadId: message.thread_id,
    accountId: message.account_id,
    accountName: message.account_name,
    folder: message.folder,
    subject: message.subject || '',
    from: {
      name: message.from_name || '',
      email: message.from_email || '',
    },
    date: message.date,
    snippet: message.snippet || '',
    isRead: !!message.is_read,
    isStarred: !!message.is_starred,
    hasAttachments: !!message.has_attachments,
  };
}

router.use(requireApplication, applicationRateLimit);

router.get('/application', (req, res) => {
  res.json({
    application: {
      id: req.application.id,
      name: req.application.name,
      permissions: req.application.permissions,
    },
  });
});

router.get('/accounts', requireApplicationPermission('account.read'), async (req, res) => {
  try {
    const accounts = await listAccountsForApplication(req.application.userId);
    res.json({ accounts });
  } catch {
    res.status(500).json({ error: 'Failed to list accounts' });
  }
});

router.get('/emails/search', requireApplicationPermission('email.search'), async (req, res) => {
  try {
    const result = await searchMessages({
      userId: req.application.userId,
      q: req.query.q,
      accountId: req.query.accountId,
      folder: req.query.folder,
      limit: req.query.limit || 20,
      offset: req.query.offset,
    });
    res.json({ emails: result.messages.map(serializeSearchResult), query: result.query });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Email search failed' });
  }
});

router.get('/emails/:id', requireApplicationPermission('email.read'), async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid email ID' });
  try {
    const email = await getEmailForApplication({
      userId: req.application.userId,
      messageId: req.params.id,
      imapManager: req.app.get('imapManager'),
    });
    res.json({ email });
  } catch (err) {
    if (err.cause) console.error('Application email read failed:', err.cause.message);
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Failed to read email' });
  }
});

router.get('/threads/:threadId', requireApplicationPermission('email.thread'), async (req, res) => {
  const threadId = String(req.params.threadId || '');
  if (!threadId || threadId.length > 500) return res.status(400).json({ error: 'Invalid thread ID' });
  try {
    const emails = await getThreadForApplication({
      userId: req.application.userId,
      threadId,
      imapManager: req.app.get('imapManager'),
    });
    res.json({ thread: { id: threadId, emails } });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Failed to read thread' });
  }
});

router.get('/emails/:id/attachments/:part', requireApplicationPermission('email.attachments'), async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid email ID' });
  try {
    const attachment = await getAttachmentForApplication({
      userId: req.application.userId,
      messageId: req.params.id,
      part: req.params.part,
      imapManager: req.app.get('imapManager'),
    });
    const encoded = encodeURIComponent(attachment.filename);
    res.setHeader('Content-Type', attachment.contentType);
    res.setHeader('Content-Length', attachment.size);
    res.setHeader('Content-Disposition', `attachment; filename="${attachment.filename}"; filename*=UTF-8''${encoded}`);
    res.send(attachment.buffer);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Failed to fetch attachment' });
  }
});

router.post('/drafts',
  requireApplicationPermission('email.draft'),
  delegateTo(draftRoutes, '/draft')
);

router.post('/emails/:id/draft-reply', requireApplicationPermission('email.draft'), async (req, res, next) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid email ID' });
  try {
    const email = await getEmailForApplication({
      userId: req.application.userId,
      messageId: req.params.id,
      imapManager: req.app.get('imapManager'),
    });
    const replyTarget = email.replyTo?.[0]?.email || email.from.email;
    req.body = {
      ...req.body,
      accountId: req.body.accountId || email.accountId,
      to: req.body.to?.length ? req.body.to : [replyTarget],
      subject: req.body.subject || (/^re:/i.test(email.subject) ? email.subject : `Re: ${email.subject}`),
      body: req.body.body || '',
      bodyIsHtml: req.body.bodyIsHtml === true,
      quotedBody: req.body.includeQuoted === false ? '' : `\n\nOn ${new Date(email.date).toISOString()}, ${email.from.name || email.from.email} wrote:\n${email.text || ''}`,
      quotedBodyHtml: req.body.includeQuoted === false ? '' : `<blockquote>${email.html || email.text || ''}</blockquote>`,
      inReplyTo: email.messageId,
      references: email.messageId,
    };
    return delegateTo(draftRoutes, '/draft')(req, res, next);
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.status ? err.message : 'Failed to create reply draft' });
  }
});

router.delete('/drafts/:uid',
  requireApplicationPermission('email.draft'),
  delegateTo(draftRoutes, req => `/draft/${encodeURIComponent(req.params.uid)}?accountId=${encodeURIComponent(req.query.accountId || '')}&folder=${encodeURIComponent(req.query.folder || '')}`)
);

router.post('/send',
  requireApplicationPermission('email.send'),
  delegateTo(sendRoutes, '/send')
);

router.post('/emails/:id/reply', requireApplicationPermission('email.reply'), async (req, res, next) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid email ID' });
  try {
    const email = await getEmailForApplication({
      userId: req.application.userId,
      messageId: req.params.id,
      imapManager: req.app.get('imapManager'),
    });
    const replyTarget = email.replyTo?.[0]?.email || email.from.email;
    req.body = {
      ...req.body,
      accountId: req.body.accountId || email.accountId,
      to: req.body.to?.length ? req.body.to : [replyTarget],
      subject: req.body.subject || (/^re:/i.test(email.subject) ? email.subject : `Re: ${email.subject}`),
      body: req.body.body || '',
      bodyIsHtml: req.body.bodyIsHtml === true,
      quotedBody: req.body.includeQuoted === false ? '' : `\n\nOn ${new Date(email.date).toISOString()}, ${email.from.name || email.from.email} wrote:\n${email.text || ''}`,
      quotedBodyHtml: req.body.includeQuoted === false ? '' : `<blockquote>${email.html || email.text || ''}</blockquote>`,
      inReplyTo: email.messageId,
      references: email.messageId,
    };
    return delegateTo(sendRoutes, '/send')(req, res, next);
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.status ? err.message : 'Failed to reply' });
  }
});

router.post('/emails/:id/forward', requireApplicationPermission('email.forward'), async (req, res, next) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid email ID' });
  if (!Array.isArray(req.body.to) || !req.body.to.length) return res.status(400).json({ error: 'to is required' });
  try {
    const email = await getEmailForApplication({
      userId: req.application.userId,
      messageId: req.params.id,
      imapManager: req.app.get('imapManager'),
    });
    req.body = {
      ...req.body,
      accountId: req.body.accountId || email.accountId,
      subject: req.body.subject || (/^(fw|fwd):/i.test(email.subject) ? email.subject : `Fwd: ${email.subject}`),
      body: req.body.body || '',
      bodyIsHtml: req.body.bodyIsHtml === true,
      quotedBody: `\n\n---------- Forwarded message ----------\nFrom: ${email.from.name || ''} <${email.from.email}>\nDate: ${new Date(email.date).toISOString()}\nSubject: ${email.subject}\n\n${email.text || ''}`,
      quotedBodyHtml: `<div><strong>Forwarded message</strong><br>From: ${email.from.name || ''} &lt;${email.from.email}&gt;<br>Date: ${new Date(email.date).toISOString()}<br>Subject: ${email.subject}</div><blockquote>${email.html || email.text || ''}</blockquote>`,
      forwardedAttachments: req.body.includeAttachments === false
        ? []
        : (email.attachments || []).map(attachment => ({
          messageId: email.id,
          part: String(attachment.part ?? attachment.partId),
        })).filter(item => item.part && item.part !== 'undefined'),
    };
    return delegateTo(sendRoutes, '/send')(req, res, next);
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.status ? err.message : 'Failed to forward email' });
  }
});

router.patch('/emails/:id/read',
  requireApplicationPermission('email.modify'),
  delegateTo(mailRoutes, req => `/messages/${encodeURIComponent(req.params.id)}/read`)
);

router.patch('/emails/:id/star',
  requireApplicationPermission('email.modify'),
  delegateTo(mailRoutes, req => `/messages/${encodeURIComponent(req.params.id)}/star`)
);

router.post('/emails/:id/archive', requireApplicationPermission('email.modify'), (req, res, next) => {
  req.body = { ids: [req.params.id] };
  return delegateTo(mailRoutes, '/messages/bulk-archive')(req, res, next);
});

router.post('/emails/:id/move', requireApplicationPermission('email.move'), (req, res, next) => {
  req.body = { ids: [req.params.id], folder: req.body.folder };
  return delegateTo(mailRoutes, '/messages/bulk-move')(req, res, next);
});

router.delete('/emails/:id',
  requireApplicationPermission('email.delete'),
  delegateTo(mailRoutes, req => `/messages/${encodeURIComponent(req.params.id)}`)
);

router.get('/webhooks', requireApplicationPermission('webhook.manage'), async (req, res) => {
  const webhooks = (await listWebhooks(req.application.userId))
    .filter(webhook => webhook.applicationId === req.application.id);
  res.json({ webhooks, events: WEBHOOK_EVENTS.filter(event => event !== 'webhook.test') });
});

router.post('/webhooks', requireApplicationPermission('webhook.manage'), async (req, res) => {
  try {
    const result = await createWebhook({
      userId: req.application.userId,
      applicationId: req.application.id,
      ...req.body,
    });
    res.status(201).json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Failed to create webhook' });
  }
});

router.patch('/webhooks/:id', requireApplicationPermission('webhook.manage'), async (req, res) => {
  if (!await applicationWebhook(req, req.params.id)) return res.status(404).json({ error: 'Webhook not found' });
  try {
    const webhook = await updateWebhook({ userId: req.application.userId, webhookId: req.params.id, ...req.body });
    res.json({ webhook });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Failed to update webhook' });
  }
});

router.delete('/webhooks/:id', requireApplicationPermission('webhook.manage'), async (req, res) => {
  if (!await applicationWebhook(req, req.params.id)) return res.status(404).json({ error: 'Webhook not found' });
  await deleteWebhook({ userId: req.application.userId, webhookId: req.params.id });
  res.json({ ok: true });
});

router.post('/webhooks/:id/test', requireApplicationPermission('webhook.manage'), async (req, res) => {
  if (!await applicationWebhook(req, req.params.id)) return res.status(404).json({ error: 'Webhook not found' });
  const deliveryId = await enqueueWebhookTest({ userId: req.application.userId, webhookId: req.params.id });
  res.status(202).json({ deliveryId });
});

router.get('/webhooks/:id/deliveries', requireApplicationPermission('webhook.manage'), async (req, res) => {
  if (!await applicationWebhook(req, req.params.id)) return res.status(404).json({ error: 'Webhook not found' });
  const deliveries = await listWebhookDeliveries({ userId: req.application.userId, webhookId: req.params.id, limit: req.query.limit });
  res.json({ deliveries });
});

export default router;
