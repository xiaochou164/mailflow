import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import {
  APPLICATION_PERMISSIONS,
  createApplication,
  listApplications,
  revokeApplication,
} from '../services/applicationService.js';

const router = Router();
router.use(requireAuth);

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
    });
    res.status(201).json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Failed to create application' });
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
