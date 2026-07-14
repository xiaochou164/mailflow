import { Router } from 'express';
import {
  applicationRateLimit,
  requireApplication,
  requireApplicationPermission,
} from '../middleware/applicationAuth.js';
import { getEmailForApplication } from '../services/emailReadService.js';
import { searchMessages } from '../services/searchService.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const router = Router();

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

export default router;
