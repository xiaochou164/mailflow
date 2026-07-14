import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../utils/api.js';

const DEFAULT_PERMISSIONS = ['email.search', 'email.read'];

const fieldStyle = {
  width: '100%', padding: '9px 11px', boxSizing: 'border-box',
  borderRadius: 8, border: '1px solid var(--border)',
  background: 'var(--bg-primary)', color: 'var(--text-primary)', fontSize: 13,
};

function PermissionOption({ permission, checked, onChange, t }) {
  return (
    <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '10px 12px', borderRadius: 8, border: '1px solid var(--border-subtle)', cursor: 'pointer' }}>
      <input type="checkbox" checked={checked} onChange={event => onChange(permission, event.target.checked)} style={{ marginTop: 2 }} />
      <span>
        <span style={{ display: 'block', color: 'var(--text-primary)', fontSize: 13, fontFamily: 'JetBrains Mono, monospace' }}>{permission}</span>
        <span style={{ display: 'block', color: 'var(--text-tertiary)', fontSize: 12, marginTop: 3 }}>
          {permission === 'email.search'
            ? t('admin.integrations.developer.permissions.search')
            : t('admin.integrations.developer.permissions.read')}
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
  const [error, setError] = useState('');
  const [copied, setCopied] = useState('');
  const [newToken, setNewToken] = useState('');
  const [form, setForm] = useState({ name: '', description: '', permissions: DEFAULT_PERMISSIONS });

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
      const data = await api.applications.create(form);
      setApplications(current => [data.application, ...current]);
      setNewToken(data.token);
      setForm({ name: '', description: '', permissions: DEFAULT_PERMISSIONS });
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
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', margin: '13px 0 6px' }}>{t('admin.integrations.developer.permissionsTitle')}</div>
          <div style={{ display: 'grid', gap: 7 }}>
            {DEFAULT_PERMISSIONS.map(permission => (
              <PermissionOption key={permission} permission={permission} checked={form.permissions.includes(permission)} onChange={togglePermission} t={t} />
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
              <button onClick={() => revokeApplication(application)} disabled={revokingId === application.id} style={{ border: '1px solid rgba(248,113,113,0.25)', borderRadius: 7, background: 'transparent', color: 'var(--red)', padding: '6px 10px', cursor: 'pointer', fontSize: 12, flexShrink: 0 }}>
                {revokingId === application.id ? t('common.deleting') : t('admin.integrations.developer.revoke')}
              </button>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
              {application.permissions.map(permission => <code key={permission} style={{ padding: '3px 6px', borderRadius: 5, background: 'var(--bg-primary)', color: 'var(--accent)', fontSize: 11 }}>{permission}</code>)}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, color: 'var(--text-tertiary)', fontSize: 11, marginTop: 10 }}>
              <span>{application.keyPrefix}</span>
              <span>{t('admin.integrations.developer.createdAt', { when: new Date(application.createdAt).toLocaleString() })}</span>
              <span>{t('admin.integrations.developer.lastUsed', { when: application.lastUsedAt ? new Date(application.lastUsedAt).toLocaleString() : t('common.never') })}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
