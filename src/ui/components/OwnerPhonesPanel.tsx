import { useCallback, useEffect, useState } from 'react';
import { apiFetch, responseJson } from '../apiFetch.js';

interface OwnerDevice { id: string; label: string; createdAt: string; revokedAt?: string }
interface AuditEntry { id: string; action: 'session-send' | 'session-input'; targetId: string; createdAt: string }
interface Challenge { id: string; expiresAt: string; qr: string }
interface Status { state: 'waiting' | 'compare' | 'confirmed'; code?: string; label?: string; expiresAt: string; ownerConfirmed: boolean; deviceId?: string }

export function OwnerPhonesPanel() {
  const [devices, setDevices] = useState<OwnerDevice[]>([]);
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [audit, setAudit] = useState<Record<string, AuditEntry[]>>({});
  const refresh = useCallback(async () => setDevices(await responseJson<OwnerDevice[]>(await apiFetch('/api/owner-devices'))), []);

  useEffect(() => { void refresh().catch(() => setError('Could not load owner phones.')); }, [refresh]);
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
    try { setChallenge(await responseJson<Challenge>(await apiFetch('/api/owner-pairing/challenges', { method: 'POST' }))); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not start pairing.'); }
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
    <button className="button button-primary" disabled={busy} onClick={() => void start()} type="button">Pair a phone</button>
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
        {entry.action === 'session-send' ? 'Send requested for' : 'Control key requested for'} session {entry.targetId} · {new Date(entry.createdAt).toLocaleString()}
      </li>)}</ul>}
    </div>)}
    <p>Lost a phone? Revoke it here, then pair a replacement.</p>
  </section>;
}
