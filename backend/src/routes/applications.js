import { Router } from 'express';
import { ADMIN_ROLES, requireAuth, requireAdminRole } from '../middleware/auth.js';
import {
  acknowledgeApplicationSecurityAlert,
  listApplicationAuditEvents,
  listApplicationSecurityAlerts,
} from '../services/applicationAudit.js';
import {
  APPLICATION_PERMISSIONS,
  createApplication,
  listApplications,
  revokeApplication,
  rotateApplicationToken,
} from '../services/applicationService.js';

const router = Router();
router.use(requireAuth);
router.use(requireAdminRole(ADMIN_ROLES.DEVELOPER_APPS));

router.get('/', async (req, res) => {
  const applications = await listApplications(req.session.userId);
  res.json({ applications, availablePermissions: APPLICATION_PERMISSIONS });
});

router.post('/', async (req, res) => {
  try {
    const result = await createApplication({
      userId: req.session.userId,
      name: req.body.name,
      description: req.body.description,
      permissions: req.body.permissions,
      expiresAt: req.body.expiresAt,
      accountIds: req.body.accountIds,
      folders: req.body.folders,
      allowedIps: req.body.allowedIps,
      auditRetentionDays: req.body.auditRetentionDays,
      redactContent: req.body.redactContent,
    });
    res.status(201).json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Failed to create application' });
  }
});

router.get('/:id/audit', async (req, res) => {
  const events = await listApplicationAuditEvents({
    userId: req.session.userId,
    applicationId: req.params.id,
    limit: req.query.limit,
  });
  res.json({ events });
});

router.get('/:id/alerts', async (req, res) => {
  const alerts = await listApplicationSecurityAlerts({
    userId: req.session.userId,
    applicationId: req.params.id,
    limit: req.query.limit,
    includeAcknowledged: req.query.includeAcknowledged === 'true',
  });
  res.json({ alerts });
});

router.post('/:id/alerts/:alertId/ack', async (req, res) => {
  const acknowledged = await acknowledgeApplicationSecurityAlert({
    userId: req.session.userId,
    applicationId: req.params.id,
    alertId: req.params.alertId,
  });
  if (!acknowledged) return res.status(404).json({ error: 'Alert not found' });
  res.json({ ok: true });
});

router.post('/:id/rotate-token', async (req, res) => {
  try {
    const result = await rotateApplicationToken({
      userId: req.session.userId,
      applicationId: req.params.id,
      expiresAt: req.body.expiresAt,
    });
    if (!result) return res.status(404).json({ error: 'Application not found' });
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Failed to rotate application token' });
  }
});

router.delete('/:id', async (req, res) => {
  const revoked = await revokeApplication({
    userId: req.session.userId,
    applicationId: req.params.id,
  });
  if (!revoked) return res.status(404).json({ error: 'Application not found' });
  res.json({ ok: true });
});

export default router;
