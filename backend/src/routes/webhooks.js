import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import {
  WEBHOOK_EVENTS,
  createWebhook,
  deleteWebhook,
  enqueueWebhookTest,
  listWebhookDeliveries,
  listWebhooks,
  updateWebhook,
} from '../services/webhookService.js';

const router = Router();
router.use(requireAuth);

router.get('/', async (req, res) => {
  res.json({ webhooks: await listWebhooks(req.session.userId), events: WEBHOOK_EVENTS.filter(event => event !== 'webhook.test') });
});

router.post('/', async (req, res) => {
  try {
    const result = await createWebhook({ userId: req.session.userId, ...req.body });
    res.status(201).json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Failed to create webhook' });
  }
});

router.patch('/:id', async (req, res) => {
  try {
    const webhook = await updateWebhook({ userId: req.session.userId, webhookId: req.params.id, ...req.body });
    res.json({ webhook });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Failed to update webhook' });
  }
});

router.delete('/:id', async (req, res) => {
  const deleted = await deleteWebhook({ userId: req.session.userId, webhookId: req.params.id });
  if (!deleted) return res.status(404).json({ error: 'Webhook not found' });
  res.json({ ok: true });
});

router.post('/:id/test', async (req, res) => {
  try {
    const deliveryId = await enqueueWebhookTest({ userId: req.session.userId, webhookId: req.params.id });
    res.status(202).json({ deliveryId });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Failed to queue webhook test' });
  }
});

router.get('/:id/deliveries', async (req, res) => {
  const deliveries = await listWebhookDeliveries({ userId: req.session.userId, webhookId: req.params.id, limit: req.query.limit });
  res.json({ deliveries });
});

export default router;
