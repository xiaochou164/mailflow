import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../utils/api.js';

const PERMISSION_GROUPS = [
  {
    title: 'Read',
    permissions: [
      ['account.read', 'List connected email accounts and folders.'],
      ['email.search', 'Search email metadata and snippets.'],
      ['email.read', 'Read email content and metadata.'],
      ['email.thread', 'Read complete email threads.'],
      ['email.attachments', 'Download email attachments.'],
    ],
  },
  {
    title: 'Compose',
    permissions: [
      ['email.draft', 'Create and update drafts without sending.'],
      ['email.reply', 'Reply to an existing email.'],
      ['email.forward', 'Forward an existing email.'],
      ['email.send', 'Send new email immediately.'],
    ],
  },
  {
    title: 'Mailbox changes',
    permissions: [
      ['email.modify', 'Change read and starred state or archive email.'],
      ['email.move', 'Move email between folders.'],
      ['email.delete', 'Delete email.'],
    ],
  },
  {
    title: 'AI and automation',
    permissions: [
      ['ai.summarize', 'Summarize complete email threads with the configured AI provider.'],
      ['webhook.manage', 'Create webhooks and inspect delivery logs.'],
    ],
  },
];

const DEFAULT_PERMISSIONS = ['account.read', 'email.search', 'email.read', 'email.thread'];
const PERMISSION_DESCRIPTIONS = Object.fromEntries(
  PERMISSION_GROUPS.flatMap(group => group.permissions)
);

function defaultExpiresAt() {
  const date = new Date();
  date.setDate(date.getDate() + 90);
  return date.toISOString().slice(0, 10);
}

function parseScopeList(value) {
  return String(value || '')
    .split(/[\n,]+/)
    .map(item => item.trim())
    .filter(Boolean);
}

function formatScope(values, allLabel) {
  return values?.length ? values.join(', ') : allLabel;
}

const fieldStyle = {
  width: '100%', padding: '9px 11px', boxSizing: 'border-box',
  borderRadius: 8, border: '1px solid var(--border)',
  background: 'var(--bg-primary)', color: 'var(--text-primary)', fontSize: 13,
};

function PermissionOption({ permission, checked, onChange }) {
  return (
    <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '10px 12px', borderRadius: 8, border: '1px solid var(--border-subtle)', cursor: 'pointer' }}>
      <input type="checkbox" checked={checked} onChange={event => onChange(permission, event.target.checked)} style={{ marginTop: 2 }} />
      <span>
        <span style={{ display: 'block', color: 'var(--text-primary)', fontSize: 13, fontFamily: 'JetBrains Mono, monospace' }}>{permission}</span>
        <span style={{ display: 'block', color: 'var(--text-tertiary)', fontSize: 12, marginTop: 3 }}>
          {PERMISSION_DESCRIPTIONS[permission] || permission}
        </span>
      </span>
    </label>
  );
}

export default function DeveloperApplications() {
  const { t } = useTranslation();
  const [applications, setApplications] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [revokingId, setRevokingId] = useState(null);
  const [rotatingId, setRotatingId] = useState(null);
  const [auditOpenId, setAuditOpenId] = useState(null);
  const [auditEvents, setAuditEvents] = useState({});
  const [auditLoadingId, setAuditLoadingId] = useState(null);
  const [alertsOpenId, setAlertsOpenId] = useState(null);
  const [alerts, setAlerts] = useState({});
  const [alertsLoadingId, setAlertsLoadingId] = useState(null);
  const [ackAlertId, setAckAlertId] = useState(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState('');
  const [newToken, setNewToken] = useState('');
  const [form, setForm] = useState({
    name: '',
    description: '',
    permissions: DEFAULT_PERMISSIONS,
    expiresAt: defaultExpiresAt(),
    accountScope: '',
    folderScope: '',
    allowedIps: '',
    auditRetentionDays: '90',
    redactContent: true,
  });

  useEffect(() => {
    api.applications.list()
      .then(data => setApplications(data.applications || []))
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  const togglePermission = (permission, checked) => {
    setForm(current => ({
      ...current,
      permissions: checked
        ? [...new Set([...current.permissions, permission])]
        : current.permissions.filter(item => item !== permission),
    }));
  };

  const createApplication = async () => {
    if (!form.name.trim() || !form.permissions.length) return;
    setSaving(true);
    setError('');
    try {
      const data = await api.applications.create({
        name: form.name,
        description: form.description,
        permissions: form.permissions,
        expiresAt: form.expiresAt,
        accountIds: parseScopeList(form.accountScope),
        folders: parseScopeList(form.folderScope),
        allowedIps: parseScopeList(form.allowedIps),
        auditRetentionDays: Number(form.auditRetentionDays) || 90,
        redactContent: form.redactContent,
      });
      setApplications(current => [data.application, ...current]);
      setNewToken(data.token);
      setForm({
        name: '',
        description: '',
        permissions: DEFAULT_PERMISSIONS,
        expiresAt: defaultExpiresAt(),
        accountScope: '',
        folderScope: '',
        allowedIps: '',
        auditRetentionDays: '90',
        redactContent: true,
      });
      setShowForm(false);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const revokeApplication = async application => {
    if (!window.confirm(t('admin.integrations.developer.revokeConfirm', { name: application.name }))) return;
    setRevokingId(application.id);
    setError('');
    try {
      await api.applications.revoke(application.id);
      setApplications(current => current.filter(item => item.id !== application.id));
    } catch (err) {
      setError(err.message);
    } finally {
      setRevokingId(null);
    }
  };

  const rotateToken = async application => {
    if (!window.confirm(t('admin.integrations.developer.rotateConfirm', { name: application.name }))) return;
    setRotatingId(application.id);
    setError('');
    try {
      const data = await api.applications.rotateToken(application.id, { expiresAt: defaultExpiresAt() });
      setApplications(current => current.map(item => item.id === application.id ? data.application : item));
      setNewToken(data.token);
    } catch (err) {
      setError(err.message);
    } finally {
      setRotatingId(null);
    }
  };

  const toggleAudit = async application => {
    if (auditOpenId === application.id) {
      setAuditOpenId(null);
      return;
    }
    setAuditOpenId(application.id);
    if (auditEvents[application.id]) return;
    setAuditLoadingId(application.id);
    setError('');
    try {
      const data = await api.applications.audit(application.id);
      setAuditEvents(current => ({ ...current, [application.id]: data.events || [] }));
    } catch (err) {
      setError(err.message);
    } finally {
      setAuditLoadingId(null);
    }
  };

  const toggleAlerts = async application => {
    if (alertsOpenId === application.id) {
      setAlertsOpenId(null);
      return;
    }
    setAlertsOpenId(application.id);
    if (alerts[application.id]) return;
    setAlertsLoadingId(application.id);
    setError('');
    try {
      const data = await api.applications.alerts(application.id);
      setAlerts(current => ({ ...current, [application.id]: data.alerts || [] }));
    } catch (err) {
      setError(err.message);
    } finally {
      setAlertsLoadingId(null);
    }
  };

  const acknowledgeAlert = async (application, alert) => {
    setAckAlertId(alert.id);
    setError('');
    try {
      await api.applications.acknowledgeAlert(application.id, alert.id);
      setAlerts(current => ({
        ...current,
        [application.id]: (current[application.id] || []).filter(item => item.id !== alert.id),
      }));
    } catch (err) {
      setError(err.message);
    } finally {
      setAckAlertId(null);
    }
  };

  const copyValue = async (key, value) => {
    await navigator.clipboard.writeText(value);
    setCopied(key);
    window.setTimeout(() => setCopied(''), 1500);
  };

  const origin = window.location.origin;
  const mcpUrl = `${origin}/mcp`;
  const apiUrl = `${origin}/api/v1`;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'flex-start', marginBottom: 16 }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>{t('admin.integrations.developer.title')}</div>
          <div style={{ fontSize: 12, lineHeight: 1.55, color: 'var(--text-tertiary)', marginTop: 4 }}>{t('admin.integrations.developer.description')}</div>
        </div>
        <button onClick={() => setShowForm(value => !value)} style={{ padding: '8px 13px', border: 'none', borderRadius: 8, background: 'var(--accent)', color: 'var(--accent-text)', fontSize: 13, fontWeight: 500, cursor: 'pointer', flexShrink: 0 }}>
          {showForm ? t('common.cancel') : t('admin.integrations.developer.create')}
        </button>
      </div>

      <div style={{ display: 'grid', gap: 8, marginBottom: 16 }}>
        {[
          { key: 'api', label: t('admin.integrations.developer.apiUrl'), value: apiUrl },
          { key: 'mcp', label: t('admin.integrations.developer.mcpUrl'), value: mcpUrl },
        ].map(item => (
          <div key={item.key} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '10px 12px', border: '1px solid var(--border-subtle)', borderRadius: 8, background: 'var(--bg-tertiary)' }}>
            <span style={{ width: 70, fontSize: 11, color: 'var(--text-tertiary)', flexShrink: 0 }}>{item.label}</span>
            <code style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', color: 'var(--text-primary)', fontSize: 12 }}>{item.value}</code>
            <button onClick={() => copyValue(item.key, item.value)} style={{ border: 'none', background: 'transparent', color: 'var(--accent)', cursor: 'pointer', fontSize: 12 }}>
              {copied === item.key ? t('admin.integrations.developer.copied') : t('common.copy')}
            </button>
          </div>
        ))}
      </div>

      {showForm ? (
        <div style={{ padding: 16, marginBottom: 16, border: '1px solid var(--border)', borderRadius: 10, background: 'var(--bg-tertiary)' }}>
          <label style={{ display: 'block', fontSize: 12, color: 'var(--text-secondary)', marginBottom: 5 }}>{t('admin.integrations.developer.name')}</label>
          <input value={form.name} onChange={event => setForm(current => ({ ...current, name: event.target.value }))} placeholder={t('admin.integrations.developer.namePh')} style={fieldStyle} maxLength={100} />
          <label style={{ display: 'block', fontSize: 12, color: 'var(--text-secondary)', margin: '13px 0 5px' }}>{t('admin.integrations.developer.appDescription')}</label>
          <textarea value={form.description} onChange={event => setForm(current => ({ ...current, description: event.target.value }))} placeholder={t('admin.integrations.developer.descriptionPh')} style={{ ...fieldStyle, minHeight: 72, resize: 'vertical' }} maxLength={500} />
          <label style={{ display: 'block', fontSize: 12, color: 'var(--text-secondary)', margin: '13px 0 5px' }}>{t('admin.integrations.developer.expiresAt')}</label>
          <input type="date" value={form.expiresAt} onChange={event => setForm(current => ({ ...current, expiresAt: event.target.value }))} style={fieldStyle} />
          <div style={{ color: 'var(--text-tertiary)', fontSize: 11, marginTop: 5 }}>{t('admin.integrations.developer.expiresAtHint')}</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12, marginTop: 13 }}>
            <div>
              <label style={{ display: 'block', fontSize: 12, color: 'var(--text-secondary)', marginBottom: 5 }}>{t('admin.integrations.developer.allowedIps')}</label>
              <textarea value={form.allowedIps} onChange={event => setForm(current => ({ ...current, allowedIps: event.target.value }))} placeholder={t('admin.integrations.developer.allowedIpsPh')} style={{ ...fieldStyle, minHeight: 72, resize: 'vertical' }} />
              <div style={{ color: 'var(--text-tertiary)', fontSize: 11, marginTop: 5 }}>{t('admin.integrations.developer.allowedIpsHint')}</div>
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 12, color: 'var(--text-secondary)', marginBottom: 5 }}>{t('admin.integrations.developer.auditRetentionDays')}</label>
              <input type="number" min="1" max="3650" value={form.auditRetentionDays} onChange={event => setForm(current => ({ ...current, auditRetentionDays: event.target.value }))} style={fieldStyle} />
              <div style={{ color: 'var(--text-tertiary)', fontSize: 11, marginTop: 5 }}>{t('admin.integrations.developer.auditRetentionHint')}</div>
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12, marginTop: 13 }}>
            <div>
              <label style={{ display: 'block', fontSize: 12, color: 'var(--text-secondary)', marginBottom: 5 }}>{t('admin.integrations.developer.accountScope')}</label>
              <textarea value={form.accountScope} onChange={event => setForm(current => ({ ...current, accountScope: event.target.value }))} placeholder={t('admin.integrations.developer.accountScopePh')} style={{ ...fieldStyle, minHeight: 72, resize: 'vertical' }} />
              <div style={{ color: 'var(--text-tertiary)', fontSize: 11, marginTop: 5 }}>{t('admin.integrations.developer.accountScopeHint')}</div>
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 12, color: 'var(--text-secondary)', marginBottom: 5 }}>{t('admin.integrations.developer.folderScope')}</label>
              <textarea value={form.folderScope} onChange={event => setForm(current => ({ ...current, folderScope: event.target.value }))} placeholder={t('admin.integrations.developer.folderScopePh')} style={{ ...fieldStyle, minHeight: 72, resize: 'vertical' }} />
              <div style={{ color: 'var(--text-tertiary)', fontSize: 11, marginTop: 5 }}>{t('admin.integrations.developer.folderScopeHint')}</div>
            </div>
          </div>
          <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', marginTop: 13, padding: '10px 12px', border: '1px solid var(--border-subtle)', borderRadius: 8, cursor: 'pointer' }}>
            <input type="checkbox" checked={form.redactContent} onChange={event => setForm(current => ({ ...current, redactContent: event.target.checked }))} style={{ marginTop: 2 }} />
            <span>
              <span style={{ display: 'block', color: 'var(--text-primary)', fontSize: 13 }}>{t('admin.integrations.developer.redactContent')}</span>
              <span style={{ display: 'block', color: 'var(--text-tertiary)', fontSize: 12, marginTop: 3 }}>{t('admin.integrations.developer.redactContentHint')}</span>
            </span>
          </label>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', margin: '13px 0 6px' }}>{t('admin.integrations.developer.permissionsTitle')}</div>
          <div style={{ display: 'grid', gap: 12 }}>
            {PERMISSION_GROUPS.map(group => (
              <div key={group.title}>
                <div style={{ color: 'var(--text-tertiary)', fontSize: 11, fontWeight: 600, marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{group.title}</div>
                <div style={{ display: 'grid', gap: 7 }}>
                  {group.permissions.map(([permission]) => (
                    <PermissionOption key={permission} permission={permission} checked={form.permissions.includes(permission)} onChange={togglePermission} />
                  ))}
                </div>
              </div>
            ))}
          </div>
          <button onClick={createApplication} disabled={saving || !form.name.trim() || !form.permissions.length} style={{ marginTop: 14, padding: '8px 14px', border: 'none', borderRadius: 8, background: 'var(--accent)', color: 'var(--accent-text)', cursor: saving ? 'default' : 'pointer', opacity: saving || !form.name.trim() || !form.permissions.length ? 0.6 : 1, fontSize: 13, fontWeight: 500 }}>
            {saving ? t('common.saving') : t('admin.integrations.developer.create')}
          </button>
        </div>
      ) : null}

      {newToken ? (
        <div style={{ padding: 14, marginBottom: 16, border: '1px solid rgba(74,222,128,0.3)', borderRadius: 10, background: 'rgba(74,222,128,0.08)' }}>
          <div style={{ color: 'var(--green)', fontSize: 13, fontWeight: 600 }}>{t('admin.integrations.developer.tokenTitle')}</div>
          <div style={{ color: 'var(--text-secondary)', fontSize: 12, margin: '5px 0 10px' }}>{t('admin.integrations.developer.tokenWarning')}</div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <code style={{ flex: 1, overflowWrap: 'anywhere', padding: '9px 10px', borderRadius: 7, background: 'var(--bg-primary)', color: 'var(--text-primary)', fontSize: 12 }}>{newToken}</code>
            <button onClick={() => copyValue('token', newToken)} style={{ padding: '8px 11px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--bg-elevated)', color: 'var(--text-primary)', cursor: 'pointer', fontSize: 12 }}>
              {copied === 'token' ? t('admin.integrations.developer.copied') : t('common.copy')}
            </button>
          </div>
          <button onClick={() => setNewToken('')} style={{ marginTop: 10, border: 'none', background: 'transparent', color: 'var(--text-tertiary)', cursor: 'pointer', fontSize: 12 }}>{t('admin.integrations.developer.dismissToken')}</button>
        </div>
      ) : null}

      {error ? <div style={{ color: 'var(--red)', fontSize: 12, marginBottom: 12 }}>{error}</div> : null}
      {loading ? <div style={{ color: 'var(--text-tertiary)', fontSize: 13 }}>{t('admin.integrations.loading')}</div> : null}
      {!loading && applications.length === 0 ? <div style={{ padding: 18, textAlign: 'center', border: '1px dashed var(--border)', borderRadius: 10, color: 'var(--text-tertiary)', fontSize: 13 }}>{t('admin.integrations.developer.empty')}</div> : null}

      <div style={{ display: 'grid', gap: 10 }}>
        {applications.map(application => (
          <div key={application.id} style={{ padding: 14, border: '1px solid var(--border-subtle)', borderRadius: 10, background: 'var(--bg-tertiary)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ color: 'var(--text-primary)', fontSize: 14, fontWeight: 600 }}>{application.name}</div>
                {application.description ? <div style={{ color: 'var(--text-tertiary)', fontSize: 12, marginTop: 3 }}>{application.description}</div> : null}
              </div>
              <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                <button onClick={() => rotateToken(application)} disabled={rotatingId === application.id} style={{ border: '1px solid var(--border)', borderRadius: 7, background: 'var(--bg-elevated)', color: 'var(--text-secondary)', padding: '6px 10px', cursor: 'pointer', fontSize: 12 }}>
                  {rotatingId === application.id ? t('admin.integrations.developer.rotatingToken') : t('admin.integrations.developer.rotateToken')}
                </button>
                <button onClick={() => revokeApplication(application)} disabled={revokingId === application.id} style={{ border: '1px solid rgba(248,113,113,0.25)', borderRadius: 7, background: 'transparent', color: 'var(--red)', padding: '6px 10px', cursor: 'pointer', fontSize: 12 }}>
                  {revokingId === application.id ? t('common.deleting') : t('admin.integrations.developer.revoke')}
                </button>
              </div>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
              {application.permissions.map(permission => <code key={permission} style={{ padding: '3px 6px', borderRadius: 5, background: 'var(--bg-primary)', color: 'var(--accent)', fontSize: 11 }}>{permission}</code>)}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, color: 'var(--text-tertiary)', fontSize: 11, marginTop: 10 }}>
              <span>{application.keyPrefix}</span>
              <span>{t('admin.integrations.developer.createdAt', { when: new Date(application.createdAt).toLocaleString() })}</span>
              <span>{t('admin.integrations.developer.lastUsed', { when: application.lastUsedAt ? new Date(application.lastUsedAt).toLocaleString() : t('common.never') })}</span>
              <span>{t('admin.integrations.developer.expiresAtValue', { when: application.expiresAt ? new Date(application.expiresAt).toLocaleString() : t('common.never') })}</span>
            </div>
            <div style={{ display: 'grid', gap: 4, color: 'var(--text-tertiary)', fontSize: 11, marginTop: 9 }}>
              <div>{t('admin.integrations.developer.accountScopeValue', { value: formatScope(application.accountIds, t('admin.integrations.developer.scopeAll')) })}</div>
              <div>{t('admin.integrations.developer.folderScopeValue', { value: formatScope(application.folders, t('admin.integrations.developer.scopeAll')) })}</div>
              <div>{t('admin.integrations.developer.allowedIpsValue', { value: formatScope(application.allowedIps, t('admin.integrations.developer.scopeAll')) })}</div>
              <div>{t('admin.integrations.developer.auditRetentionValue', { count: application.auditRetentionDays || 90 })}</div>
              <div>{application.redactContent ? t('admin.integrations.developer.redactionEnabled') : t('admin.integrations.developer.redactionDisabled')}</div>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
              <button onClick={() => toggleAlerts(application)} style={{ border: '1px solid var(--border)', borderRadius: 7, background: 'var(--bg-elevated)', color: 'var(--text-secondary)', padding: '6px 10px', cursor: 'pointer', fontSize: 12 }}>
                {alertsOpenId === application.id ? t('admin.integrations.developer.hideAlerts') : t('admin.integrations.developer.showAlerts')}
              </button>
              <button onClick={() => toggleAudit(application)} style={{ border: '1px solid var(--border)', borderRadius: 7, background: 'var(--bg-elevated)', color: 'var(--text-secondary)', padding: '6px 10px', cursor: 'pointer', fontSize: 12 }}>
                {auditOpenId === application.id ? t('admin.integrations.developer.hideAudit') : t('admin.integrations.developer.showAudit')}
              </button>
            </div>
            {alertsOpenId === application.id ? (
              <div style={{ marginTop: 10, border: '1px solid var(--border-subtle)', borderRadius: 8, overflow: 'hidden', background: 'var(--bg-primary)' }}>
                {alertsLoadingId === application.id ? (
                  <div style={{ padding: 10, color: 'var(--text-tertiary)', fontSize: 12 }}>{t('admin.integrations.developer.alertsLoading')}</div>
                ) : (alerts[application.id] || []).length === 0 ? (
                  <div style={{ padding: 10, color: 'var(--text-tertiary)', fontSize: 12 }}>{t('admin.integrations.developer.alertsEmpty')}</div>
                ) : (
                  (alerts[application.id] || []).map(alert => (
                    <div key={alert.id} style={{ display: 'grid', gridTemplateColumns: '86px minmax(0, 1fr) 150px 80px', gap: 8, alignItems: 'center', padding: '8px 10px', borderTop: '1px solid var(--border-subtle)', fontSize: 11 }}>
                      <code style={{ color: alert.severity === 'high' ? 'var(--red)' : 'var(--accent)' }}>{alert.type}</code>
                      <span style={{ color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{alert.message}</span>
                      <span style={{ color: 'var(--text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{new Date(alert.createdAt).toLocaleString()}</span>
                      <button onClick={() => acknowledgeAlert(application, alert)} disabled={ackAlertId === alert.id} style={{ border: 'none', background: 'transparent', color: 'var(--accent)', cursor: 'pointer', fontSize: 12 }}>
                        {ackAlertId === alert.id ? t('common.saving') : t('admin.integrations.developer.ackAlert')}
                      </button>
                    </div>
                  ))
                )}
              </div>
            ) : null}
            {auditOpenId === application.id ? (
              <div style={{ marginTop: 10, border: '1px solid var(--border-subtle)', borderRadius: 8, overflow: 'hidden', background: 'var(--bg-primary)' }}>
                {auditLoadingId === application.id ? (
                  <div style={{ padding: 10, color: 'var(--text-tertiary)', fontSize: 12 }}>{t('admin.integrations.developer.auditLoading')}</div>
                ) : (auditEvents[application.id] || []).length === 0 ? (
                  <div style={{ padding: 10, color: 'var(--text-tertiary)', fontSize: 12 }}>{t('admin.integrations.developer.auditEmpty')}</div>
                ) : (
                  (auditEvents[application.id] || []).slice(0, 20).map(event => (
                    <div key={event.id} style={{ display: 'grid', gridTemplateColumns: '70px minmax(0, 1fr) 58px 70px 150px', gap: 8, alignItems: 'center', padding: '8px 10px', borderTop: '1px solid var(--border-subtle)', fontSize: 11 }}>
                      <code style={{ color: 'var(--accent)' }}>{event.method}</code>
                      <code style={{ color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{event.path}</code>
                      <span style={{ color: event.statusCode >= 400 ? 'var(--red)' : 'var(--green)', fontWeight: 600 }}>{event.statusCode}</span>
                      <span style={{ color: 'var(--text-tertiary)' }}>{event.durationMs} ms</span>
                      <span style={{ color: 'var(--text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{new Date(event.createdAt).toLocaleString()}</span>
                    </div>
                  ))
                )}
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}
