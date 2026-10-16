import { useState } from 'react';
import { api, date, mins, num, price, usd } from '../api';
import { BarChart, Card, ErrorText, Icon, Loading, Modal, Page, Stat, StatStrip, useAsync } from '../ui';

export function AdminOverview() {
  const stats = useAsync(() => api('/api/admin/stats'));
  const s = stats.data;
  if (!s) return <Loading error={stats.error} />;
  const t = s.this_month;
  return (
    <Page title="Revenue & cost" subtitle="Managed (OpsTrellis Cloud) usage only. Subscription revenue is current Pro users × list price.">
      <StatStrip>
        <Stat label="Margin this month" value={usd(t.margin_usd)} hint={`${usd(t.revenue_usd)} revenue − ${usd(t.provider_cost_usd)} provider cost`} />
        <Stat label="Pro subscribers" value={num(s.users.pro)} hint={`${usd(t.subscription_revenue_usd)} MRR`} />
        <Stat label="Users" value={num(s.users.total)} hint={`${s.users.new_this_month} new · ${s.users.active_this_month} active this month`} />
        <Stat label="Managed minutes" value={num(t.managed_minutes, 1)} hint="This month" />
      </StatStrip>
      <Card title="Billed usage vs provider cost" actions={<span className="card-meta">By month</span>}>
        <BarChart
          data={s.monthly.map((m: any) => ({ label: m.month, values: [m.billed_usd, m.provider_cost_usd] }))}
          series={[
            { name: 'Billed usage', color: 'var(--series-1)' },
            { name: 'Provider cost', color: 'var(--series-2)' },
          ]}
          format={(n) => usd(n)}
          empty="No billed usage or provider cost yet."
        />
        <table>
          <thead>
            <tr>
              <th>Month</th>
              <th className="num">Active users</th>
              <th className="num">Managed min</th>
              <th className="num">Billed usage</th>
              <th className="num">Provider cost</th>
            </tr>
          </thead>
          <tbody>
            {s.monthly.map((m: any) => (
              <tr key={m.month}>
                <td>{m.month}</td>
                <td className="num">{m.active_users}</td>
                <td className="num">{mins(m.managed_minutes)}</td>
                <td className="num">{usd(m.billed_usd)}</td>
                <td className="num">{usd(m.provider_cost_usd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <Card title="Per model" actions={<span className="card-meta">This month</span>}>
        {s.per_model.length === 0 ? (
          <p className="muted empty">No gateway traffic this month.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Model</th>
                <th className="num">Requests</th>
                <th className="num">Errors</th>
                <th className="num">Minutes / tokens</th>
                <th className="num">Avg latency</th>
                <th className="num">Provider cost</th>
                <th className="num">Billed</th>
              </tr>
            </thead>
            <tbody>
              {s.per_model.map((m: any) => (
                <tr key={m.model}>
                  <td>
                    <code>{m.model}</code>
                  </td>
                  <td className="num">{num(m.requests)}</td>
                  <td className="num">{num(m.errors)}</td>
                  <td className="num">{m.kind === 'llm' ? `${num(m.tokens)} tok` : mins(m.minutes)}</td>
                  <td className="num">{num(m.avg_latency_ms)} ms</td>
                  <td className="num">{usd(m.provider_cost_usd)}</td>
                  <td className="num">{usd(m.billed_usd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </Page>
  );
}

export function AdminUsers() {
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const list = useAsync(() => api(`/api/admin/users?q=${encodeURIComponent(q)}&page=${page}&page_size=25`), [q, page]);
  const update = async (id: string, patch: object) => {
    setError(null);
    try {
      await api(`/api/admin/users/${id}`, { method: 'PATCH', json: patch });
      list.reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const pages = list.data ? Math.max(1, Math.ceil(list.data.total / list.data.page_size)) : 1;
  return (
    <Page title="Users" subtitle="Roles, plans and access for everyone on this server." actions={<input className="search" type="search" aria-label="Search users" placeholder="Search email or name" value={q} onChange={(e) => (setQ(e.target.value), setPage(1))} />}>
      <ErrorText error={error} />
      <Card>
        {!list.data ? (
          <Loading error={list.error} />
        ) : (
          <>
            <table className="stack">
              <thead>
                <tr>
                  <th>User</th>
                  <th>Role</th>
                  <th>Plan</th>
                  <th className="num">Min this month</th>
                  <th>Joined</th>
                  <th>Status</th>
                  <th className="num">Actions</th>
                </tr>
              </thead>
              <tbody>
                {list.data.users.map((u: any) => (
                  <tr key={u.id} className={u.disabled ? 'dim' : ''}>
                    <td>
                      <span className="cell-title">
                        <span className="avatar sm" aria-hidden>
                          {(u.name || u.email).trim().charAt(0).toUpperCase()}
                        </span>
                        <span>
                          <div>{u.email}</div>
                          <div className="muted small">{u.name}</div>
                        </span>
                      </span>
                    </td>
                    <td>
                      <select value={u.role} onChange={(e) => update(u.id, { role: e.target.value })}>
                        <option value="user">user</option>
                        <option value="admin">admin</option>
                      </select>
                    </td>
                    <td>
                      <select value={u.plan} onChange={(e) => update(u.id, { plan: e.target.value })}>
                        <option value="free">free</option>
                        <option value="pro">pro</option>
                      </select>
                      {u.plan_status !== 'active' && <div className="error small">{u.plan_status}</div>}
                    </td>
                    <td className="num" data-label="This month">
                      {num(u.managed_minutes_this_month, 1)} min
                    </td>
                    <td className="nowrap" data-label="Joined">
                      {date(u.created_at)}
                    </td>
                    <td>{u.disabled ? <span className="pill off">Disabled</span> : <span className="pill ok">Active</span>}</td>
                    <td className="num nowrap">
                      <button className="ghost" onClick={() => setSelected(u.id)}>
                        Usage
                      </button>
                      <button className={`ghost ${u.disabled ? '' : 'danger'}`} onClick={() => update(u.id, { disabled: !u.disabled })}>
                        {u.disabled ? 'Enable' : 'Disable'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {list.data.users.length === 0 && <p className="muted empty">No users match “{q}”.</p>}
            <div className="pager">
              <span className="muted">{list.data.total} users</span>
              <button className="ghost" disabled={page <= 1} onClick={() => setPage(page - 1)}>
                ← Prev
              </button>
              <span>
                {page} / {pages}
              </span>
              <button className="ghost" disabled={page >= pages} onClick={() => setPage(page + 1)}>
                Next →
              </button>
            </div>
          </>
        )}
      </Card>
      {selected && <UserUsage id={selected} onClose={() => setSelected(null)} />}
    </Page>
  );
}

function UserUsage({ id, onClose }: { id: string; onClose: () => void }) {
  const d = useAsync(() => api(`/api/admin/users/${id}`), [id]);
  return (
    <Modal title={d.data?.user.email ?? 'User'} onClose={onClose}>
      {!d.data ? (
        <Loading error={d.error} />
      ) : (
        <>
          <StatStrip>
            <Stat label="Managed this period" value={`${num(d.data.summary.usage.managed_minutes, 1)} min`} hint={`of ${num(d.data.summary.usage.included_minutes)} included`} />
            <Stat label="Words (all time)" value={num(d.data.stats.totals.words)} />
            <Stat label="Billed this period" value={usd(d.data.summary.usage.cost_usd)} />
          </StatStrip>
          {d.data.recent_events.length === 0 ? (
            <p className="muted empty">No usage recorded yet.</p>
          ) : (
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Model</th>
                <th>Source</th>
                <th className="num">Seconds</th>
                <th className="num">Provider cost</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {d.data.recent_events.map((e: any) => (
                <tr key={e.id}>
                  <td className="nowrap">{new Date(e.created_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</td>
                  <td>
                    <code>{e.model}</code>
                  </td>
                  <td>{e.source === 'gateway' ? 'cloud' : e.mode}</td>
                  <td className="num">{num(e.audio_seconds, 1)}</td>
                  <td className="num">{usd(e.provider_cost_usd)}</td>
                  <td>{e.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
          )}
        </>
      )}
    </Modal>
  );
}

const EMPTY_MODEL = {
  id: '',
  kind: 'stt',
  provider: '',
  upstream_model: '',
  display_name: '',
  streaming: false,
  price_per_min_usd: 0.02,
  cost_per_min_usd: 0,
  input_per_1m_usd: 0,
  output_per_1m_usd: 0,
  enabled: true,
  fallback_order: 100,
};
type ModelForm = typeof EMPTY_MODEL;

export function AdminModels() {
  const list = useAsync(() => api('/api/admin/models'));
  const [editing, setEditing] = useState<{ model: ModelForm; isNew: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const patch = async (id: string, body: object) => {
    await api(`/api/admin/models/${id}`, { method: 'PATCH', json: body });
    list.reload();
  };
  const save = async () => {
    if (!editing) return;
    setError(null);
    try {
      const { id, ...rest } = editing.model;
      if (editing.isNew) await api('/api/admin/models', { json: editing.model });
      else await api(`/api/admin/models/${id}`, { method: 'PATCH', json: rest });
      setEditing(null);
      list.reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const remove = async (id: string) => {
    if (!confirm(`Delete ${id}?`)) return;
    await api(`/api/admin/models/${id}`, { method: 'DELETE' });
    list.reload();
  };
  const m = editing?.model;
  const set = (k: keyof ModelForm, v: unknown) => setEditing((e) => e && { ...e, model: { ...e.model, [k]: v } });
  const numField = (k: keyof ModelForm, label: string) => (
    <label>
      {label}
      <input type="number" step="any" min={0} value={m![k] as number} onChange={(e) => set(k, Number(e.target.value))} />
    </label>
  );
  return (
    <Page title="Model catalog" subtitle="Lower fallback order is tried first. Disabled models are hidden from users." actions={
        <button className="primary" onClick={() => setEditing({ model: { ...EMPTY_MODEL }, isNew: true })}>
          <Icon name="plus" size={16} />
          Add model
        </button>
      }>
      <Card>
        {!list.data ? (
          <Loading error={list.error} />
        ) : (
          <table className="stack">
            <thead>
              <tr>
                <th>Model</th>
                <th>Kind</th>
                <th className="num">Order</th>
                <th className="num">Our price</th>
                <th className="num">Provider cost</th>
                <th>Enabled</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.data.models.map((x: any) => (
                <tr key={x.id} className={x.enabled ? '' : 'dim'}>
                  <td>
                    <div>{x.display_name}</div>
                    <code className="small">{x.id}</code>
                  </td>
                  <td>
                    <span className={`pill kind-${x.kind}`}>{x.kind === 'stt' ? 'Speech' : 'LLM'}</span>
                    {x.streaming && <span className="pill">stream</span>}
                  </td>
                  <td className="num" data-label="Order">
                    {x.fallback_order}
                  </td>
                  <td className="num" data-label="Our price">
                    {x.kind === 'stt' ? `${price(x.price_per_min_usd)}/min` : '—'}
                  </td>
                  <td className="num" data-label="Cost">{x.kind === 'stt' ? `${price(x.cost_per_min_usd)}/min` : `${price(x.input_per_1m_usd)} / ${price(x.output_per_1m_usd)} per 1M`}</td>
                  <td data-label="Enabled">
                    <input type="checkbox" checked={x.enabled} onChange={(e) => patch(x.id, { enabled: e.target.checked })} aria-label="Enabled" />
                  </td>
                  <td className="num nowrap">
                    <button className="ghost" onClick={() => setEditing({ model: { ...x }, isNew: false })}>
                      Edit
                    </button>
                    <button className="ghost danger" onClick={() => remove(x.id)}>
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      {m && (
        <Modal title={editing!.isNew ? 'Add model' : `Edit ${m.id}`} onClose={() => setEditing(null)}>
          <div className="form grid two">
            {editing!.isNew && (
              <label>
                Catalog id
                <input placeholder="provider/model" value={m.id} onChange={(e) => set('id', e.target.value)} />
              </label>
            )}
            <label>
              Kind
              <select value={m.kind} onChange={(e) => set('kind', e.target.value)}>
                <option value="stt">Speech-to-text</option>
                <option value="llm">LLM</option>
              </select>
            </label>
            <label>
              Provider
              <input placeholder="openai, groq, deepgram, local…" value={m.provider} onChange={(e) => set('provider', e.target.value)} />
            </label>
            <label>
              Upstream model
              <input value={m.upstream_model} onChange={(e) => set('upstream_model', e.target.value)} />
            </label>
            <label>
              Display name
              <input value={m.display_name} onChange={(e) => set('display_name', e.target.value)} />
            </label>
            {numField('fallback_order', 'Fallback order')}
            {m.kind === 'stt' ? (
              <>
                {numField('price_per_min_usd', 'Our price per min (USD)')}
                {numField('cost_per_min_usd', 'Provider cost per min (USD)')}
              </>
            ) : (
              <>
                {numField('input_per_1m_usd', 'Input per 1M tokens (USD)')}
                {numField('output_per_1m_usd', 'Output per 1M tokens (USD)')}
              </>
            )}
            <label className="check">
              <input type="checkbox" checked={m.streaming} onChange={(e) => set('streaming', e.target.checked)} /> Supports streaming
            </label>
            <label className="check">
              <input type="checkbox" checked={m.enabled} onChange={(e) => set('enabled', e.target.checked)} /> Enabled
            </label>
          </div>
          <ErrorText error={error} />
          <div className="modal-actions">
            <button className="ghost" onClick={() => setEditing(null)}>
              Cancel
            </button>
            <button className="primary" onClick={save}>
              Save
            </button>
          </div>
        </Modal>
      )}
    </Page>
  );
}

export function AdminProviders() {
  const list = useAsync(() => api('/api/admin/providers'));
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const save = async (provider: string) => {
    setError(null);
    try {
      await api(`/api/admin/providers/${provider}`, { method: 'PUT', json: { key: keys[provider] } });
      setKeys({ ...keys, [provider]: '' });
      list.reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const remove = async (provider: string) => {
    await api(`/api/admin/providers/${provider}`, { method: 'DELETE' });
    list.reload();
  };
  return (
    <Page title="Provider keys" subtitle="Platform keys used by the gateway. Stored AES-256-GCM encrypted with MASTER_KEY; the environment variable is used when none is saved.">
      <ErrorText error={error} />
      <Card>
        {!list.data ? (
          <Loading error={list.error} />
        ) : (
          <table className="stack">
            <thead>
              <tr>
                <th>Provider</th>
                <th>Status</th>
                <th>Set key</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.data.providers.map((p: any) => (
                <tr key={p.provider}>
                  <td>
                    <span className="cell-title">
                      <span className="cell-icon">
                        <Icon name="key" size={16} />
                      </span>
                      <span>
                        <div>{p.label}</div>
                        <code className="small">{p.env}</code>
                      </span>
                    </span>
                  </td>
                  <td>
                    {p.source === 'database' ? (
                      <span className="pill ok">Saved ····{p.last4}</span>
                    ) : p.source === 'env' ? (
                      <span className="pill ok">From env</span>
                    ) : (
                      <span className="pill off">Not configured</span>
                    )}
                  </td>
                  <td className="grow">
                    <div className="row">
                      <input type="password" placeholder="Paste key" autoComplete="off" value={keys[p.provider] ?? ''} onChange={(e) => setKeys({ ...keys, [p.provider]: e.target.value })} />
                      <button disabled={!keys[p.provider]} onClick={() => save(p.provider)}>
                        Save
                      </button>
                    </div>
                  </td>
                  <td className="num">
                    {p.source === 'database' && (
                      <button className="ghost danger" onClick={() => remove(p.provider)}>
                        Remove
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </Page>
  );
}
