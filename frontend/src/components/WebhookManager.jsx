import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../utils/api.js';

const inputStyle = {
  width: '100%', boxSizing: 'border-box', padding: '9px 11px', borderRadius: 8,
  border: '1px solid var(--border)', background: 'var(--bg-primary)',
  color: 'var(--text-primary)', fontSize: 13,
};

export default function WebhookManager() {
  const { t } = useTranslation();
  const [webhooks, setWebhooks] = useState([]);
  const [events, setEvents] = useState([]);
  const [form, setForm] = useState({ name: '', url: '', events: [] });
  const [secret, setSecret] = useState('');
  const [error, setError] = useState('');
  const [deliveries, setDeliveries] = useState({});

  const load = async () => {
    const data = await api.webhooks.list();
    setWebhooks(data.webhooks || []);
    setEvents(data.events || []);
  };

  useEffect(() => { load().catch(err => setError(err.message)); }, []);

  const toggleEvent = event => setForm(current => ({
    ...current,
    events: current.events.includes(event)
      ? current.events.filter(item => item !== event)
      : [...current.events, event],
  }));

  const create = async () => {
    setError('');
    try {
      const data = await api.webhooks.create(form);
      setSecret(data.secret);
      setForm({ name: '', url: '', events: [] });
      await load();
    } catch (err) { setError(err.message); }
  };

  const test = async id => {
    setError('');
    try {
      await api.webhooks.test(id);
      window.setTimeout(() => showDeliveries(id), 800);
    } catch (err) { setError(err.message); }
  };

  const showDeliveries = async id => {
    try {
      const data = await api.webhooks.deliveries(id);
      setDeliveries(current => ({ ...current, [id]: data.deliveries || [] }));
    } catch (err) { setError(err.message); }
  };

  return (
    <div>
      <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>{t('admin.integrations.webhooks.title')}</div>
      <div style={{ fontSize: 12, color: 'var(--text-tertiary)', margin: '4px 0 16px', lineHeight: 1.5 }}>
        {t('admin.integrations.webhooks.description')}
      </div>

      <div style={{ padding: 14, border: '1px solid var(--border)', borderRadius: 10, background: 'var(--bg-tertiary)', marginBottom: 16 }}>
        <input style={inputStyle} placeholder={t('admin.integrations.webhooks.namePh')} value={form.name} onChange={event => setForm(current => ({ ...current, name: event.target.value }))} />
        <input style={{ ...inputStyle, marginTop: 8 }} placeholder="https://example.com/webhooks/mailflow" value={form.url} onChange={event => setForm(current => ({ ...current, url: event.target.value }))} />
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
          {events.map(event => (
            <label key={event} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, color: 'var(--text-secondary)' }}>
              <input type="checkbox" checked={form.events.includes(event)} onChange={() => toggleEvent(event)} /> {event}
            </label>
          ))}
        </div>
        <button onClick={create} disabled={!form.name.trim() || !form.url.trim() || !form.events.length} style={{ marginTop: 12, padding: '8px 13px', border: 0, borderRadius: 8, background: 'var(--accent)', color: 'var(--accent-text)', opacity: !form.name.trim() || !form.url.trim() || !form.events.length ? 0.5 : 1, cursor: 'pointer' }}>
          {t('admin.integrations.webhooks.create')}
        </button>
      </div>

      {secret && (
        <div style={{ padding: 12, borderRadius: 8, background: 'rgba(74,222,128,0.08)', border: '1px solid rgba(74,222,128,0.3)', marginBottom: 14 }}>
          <div style={{ fontSize: 12, color: 'var(--green)', fontWeight: 600 }}>{t('admin.integrations.webhooks.secretWarning')}</div>
          <code style={{ display: 'block', overflowWrap: 'anywhere', marginTop: 7, color: 'var(--text-primary)', fontSize: 12 }}>{secret}</code>
          <button onClick={() => setSecret('')} style={{ marginTop: 7, border: 0, background: 'transparent', color: 'var(--text-tertiary)', cursor: 'pointer' }}>{t('admin.integrations.webhooks.dismiss')}</button>
        </div>
      )}
      {error && <div style={{ color: 'var(--red)', fontSize: 12, marginBottom: 10 }}>{error}</div>}

      <div style={{ display: 'grid', gap: 10 }}>
        {webhooks.map(webhook => (
          <div key={webhook.id} style={{ padding: 14, border: '1px solid var(--border-subtle)', borderRadius: 10, background: 'var(--bg-tertiary)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ color: 'var(--text-primary)', fontWeight: 600, fontSize: 13 }}>{webhook.name}</div>
                <div style={{ color: 'var(--text-tertiary)', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', marginTop: 3 }}>{webhook.url}</div>
              </div>
              <label style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                <input type="checkbox" checked={webhook.enabled} onChange={async event => { await api.webhooks.update(webhook.id, { enabled: event.target.checked }); await load(); }} /> {t('admin.integrations.webhooks.enabled')}
              </label>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 8 }}>
              {webhook.events.map(event => <code key={event} style={{ fontSize: 10, color: 'var(--accent)' }}>{event}</code>)}
            </div>
            {webhook.lastError && <div style={{ color: 'var(--red)', fontSize: 11, marginTop: 8 }}>{webhook.lastError}</div>}
            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              <button onClick={() => test(webhook.id)}>{t('admin.integrations.webhooks.test')}</button>
              <button onClick={() => showDeliveries(webhook.id)}>{t('admin.integrations.webhooks.deliveries')}</button>
              <button onClick={async () => { if (window.confirm(t('admin.integrations.webhooks.deleteConfirm', { name: webhook.name }))) { await api.webhooks.remove(webhook.id); await load(); } }} style={{ color: 'var(--red)' }}>{t('admin.integrations.webhooks.delete')}</button>
            </div>
            {deliveries[webhook.id] && (
              <div style={{ marginTop: 10, display: 'grid', gap: 5 }}>
                {deliveries[webhook.id].slice(0, 10).map(delivery => (
                  <div key={delivery.id} style={{ fontSize: 11, color: 'var(--text-tertiary)', display: 'flex', gap: 8 }}>
                    <span>{delivery.event}</span><strong>{delivery.status}</strong><span>{t('admin.integrations.webhooks.attempts', { count: delivery.attemptCount })}</span>{delivery.responseStatus ? <span>HTTP {delivery.responseStatus}</span> : null}
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
