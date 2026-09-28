import { useCallback, useEffect, useState } from 'react';
import { apiFetch, responseJson } from '../apiFetch.js';

interface OwnerDevice { id: string; label: string; createdAt: string; revokedAt?: string }
interface AuditEntry { id: string; action: keyof typeof AUDIT_LABEL; targetId: string; createdAt: string }

const AUDIT_LABEL = {
  'session-send': 'Send requested for session',
  'session-input': 'Control key requested for session',
  'personal-task-submit': 'Asked for personal task',
  'personal-task-retry': 'Retried personal task',
  'filing-approve': 'Approved filing plan for task',
  'filing-retry': 'Retried unmoved files for task',
  'filing-undo': 'Undid recorded moves for task',
} as const;
interface Challenge { id: string; expiresAt: string; qr: string }
interface Availability { state: 'ready' | 'off' | 'no-tailscale'; canToggle: boolean; phoneAccess: boolean }
interface Status { state: 'waiting' | 'compare' | 'confirmed'; code?: string; label?: string; expiresAt: string; ownerConfirmed: boolean; deviceId?: string }

export function OwnerPhonesPanel() {
  const [devices, setDevices] = useState<OwnerDevice[]>([]);
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [audit, setAudit] = useState<Record<string, AuditEntry[]>>({});
  const [availability, setAvailability] = useState<Availability | null>(null);
  const [restarting, setRestarting] = useState(false);
  const refresh = useCallback(async () => setDevices(await responseJson<OwnerDevice[]>(await apiFetch('/api/owner-devices'))), []);

  useEffect(() => { void refresh().catch(() => setError('Could not load owner phones.')); }, [refresh]);
  useEffect(() => {
    void apiFetch('/api/owner-pairing/availability').then((response) => responseJson<Availability>(response)).then(setAvailability).catch(() => undefined);
  }, []);
  useEffect(() => {
    if (!restarting) return;
    // The service is relaunching; keep asking until the new one answers.
    const timer = window.setInterval(() => {
      void apiFetch('/api/owner-pairing/availability').then((response) => responseJson<Availability>(response)).then((next) => {
        setAvailability(next); setRestarting(false);
      }).catch(() => undefined);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [restarting]);
  useEffect(() => {
    if (!challenge || status?.deviceId) return;
    let active = true;
    const tick = async () => {
      try {
        const next = await responseJson<Status>(await apiFetch(`/api/owner-pairing/challenges/${challenge.id}`));
        if (active) { setStatus(next); if (next.deviceId) void refresh(); }
      } catch { if (active) { setError('Pairing expired. Start again.'); setChallenge(null); } }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), 1000);
    return () => { active = false; window.clearInterval(timer); };
  }, [challenge, status?.state, status?.deviceId, refresh]);

  const start = async () => {
    setError(null); setStatus(null); setBusy(true);
    try {
      const response = await apiFetch('/api/owner-pairing/challenges', { method: 'POST' });
      if (!response.ok) throw new Error(((await response.json().catch(() => ({}))) as { error?: string }).error ?? `request failed: ${response.status}`);
      setChallenge(await response.json() as Challenge);
    }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not start pairing.'); }
    finally { setBusy(false); }
  };
  const setPhoneAccess = async (enabled: boolean) => {
    setError(null); setBusy(true);
    try {
      await responseJson(await apiFetch('/api/owner-pairing/phone-access', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled }),
      }));
      setChallenge(null); setStatus(null); setRestarting(true);
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not change phone access.'); }
    finally { setBusy(false); }
  };
  const confirm = async () => {
    if (!challenge || !status?.code) return;
    setBusy(true);
    try {
      await responseJson(await apiFetch(`/api/owner-pairing/challenges/${challenge.id}/confirm`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: status.code }),
      }));
      setStatus((current) => current ? { ...current, ownerConfirmed: true } : current);
      setError(null);
    } catch (e) { setError(e instanceof Error ? e.message : 'Confirmation failed.'); }
    finally { setBusy(false); }
  };
  const revoke = async (device: OwnerDevice) => {
    if (!window.confirm(`Revoke ${device.label}? It will lose access immediately.`)) return;
    try { await responseJson(await apiFetch(`/api/owner-devices/${device.id}/revoke`, { method: 'POST' })); await refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not revoke phone.'); }
  };
  const showAudit = async (device: OwnerDevice) => {
    try {
      const entries = await responseJson<AuditEntry[]>(await apiFetch(`/api/owner-devices/${device.id}/audit`));
      setAudit((current) => ({ ...current, [device.id]: entries }));
    } catch { setError('Could not load phone activity.'); }
  };

  return <section>
    <h2>Owner phones</h2>
    <p>Pair your iPhone while it and this Mac are on the same tailnet. Each phone gets its own credential.</p>
    {restarting && <p role="status">Restarting AgentDeck…</p>}
    {!restarting && availability?.state === 'off' && <div className="settings-card">
      <p>Phone access is off, so AgentDeck only listens on this Mac. Turn it on to let paired phones reach it over Tailscale. AgentDeck restarts to apply this.</p>
      <button className="button button-primary" disabled={busy} onClick={() => void setPhoneAccess(true)} type="button">Turn on phone access</button>
    </div>}
    {!restarting && availability?.state === 'no-tailscale' && <p>Tailscale isn't running on this Mac, or MagicDNS is off. Start Tailscale, then restart AgentDeck.</p>}
    <button className="button button-primary" disabled={busy || restarting || (availability !== null && availability.state !== 'ready')} onClick={() => void start()} type="button">Pair a phone</button>
    {!restarting && availability?.canToggle && availability.phoneAccess && <button className="button" disabled={busy} onClick={() => void setPhoneAccess(false)} type="button">Turn off phone access</button>}
    {challenge && status?.state !== 'confirmed' && <div className="settings-card">
      <p>Scan this QR code in AgentDeck Phone. It expires at {new Date(challenge.expiresAt).toLocaleTimeString()}.</p>
      <img alt="Short-lived owner phone pairing QR code" height="256" src={challenge.qr} width="256" />
      {status?.code && <p>Confirm that <strong>{status.label}</strong> shows this same code: <strong>{status.code}</strong></p>}
      {status?.code && !status.ownerConfirmed && <button className="button button-primary" disabled={busy} onClick={() => void confirm()} type="button">Same code on both devices — confirm here</button>}
      {status?.ownerConfirmed && <p>Confirmed on this Mac. Waiting for the phone.</p>}
    </div>}
    {status?.deviceId && <p>Phone paired. Its credential is stored on the phone.</p>}
    {error && <p className="form-error" role="alert">{error}</p>}
    <h3>Devices</h3>
    {devices.length === 0 && <p>No owner phones paired.</p>}
    {devices.map((device) => <div className="settings-card" key={device.id}>
      <strong>{device.label}</strong> · Added {new Date(device.createdAt).toLocaleDateString()}
      {device.revokedAt ? <span> · Revoked</span> : <button className="button" onClick={() => void revoke(device)} type="button">Revoke</button>}
      <button className="button" onClick={() => void showAudit(device)} type="button">View activity</button>
      {audit[device.id] && <ul>{(audit[device.id] ?? []).map((entry) => <li key={entry.id}>
        {AUDIT_LABEL[entry.action] ?? entry.action} {entry.targetId} · {new Date(entry.createdAt).toLocaleString()}
      </li>)}</ul>}
    </div>)}
    <p>Lost a phone? Revoke it here, then pair a replacement.</p>
  </section>;
}
