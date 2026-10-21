import { useEffect, useState } from "react";
import type { DriveRecordView, FlowTarget, HostBridge, PullLogsResult, RefreshCommandPreview, RefreshResult, RemovalCommandPreview, RemoveOptions, RemoveResult, ResetSupport, StepResult } from "./contract";

const NO_STEPS: RemoveOptions = { pullLogs: false, eraseStorage: false, revokeCredentials: false, forgetDrive: false };
const STEPS: [keyof RemoveOptions, string][] = [["pullLogs", "Pull logs first"], ["eraseStorage", "Erase persistent storage"], ["revokeCredentials", "Revoke credentials"], ["forgetDrive", "Forget this drive on this computer"]];

function message(failure: unknown): string {
  return typeof failure === "string" ? failure : failure instanceof Error ? failure.message : "The action failed. Review it and try again.";
}
function describe(step: StepResult): string {
  return step.status === "completed" ? "completed" : `${step.status}: ${step.reason}`;
}

export function ManageDrives({ bridge }: { bridge: HostBridge }) {
  const [records, setRecords] = useState<DriveRecordView[]>([]);
  const [targets, setTargets] = useState<FlowTarget[]>([]);
  const [reset, setReset] = useState<ResetSupport | null>(null);
  const [driveId, setDriveId] = useState("");
  const [targetId, setTargetId] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState<RefreshCommandPreview | null>(null);
  const [refreshed, setRefreshed] = useState<RefreshResult | null>(null);
  const [pulled, setPulled] = useState<PullLogsResult | null>(null);
  const [options, setOptions] = useState<RemoveOptions>(NO_STEPS);
  const [removal, setRemoval] = useState<RemovalCommandPreview | null>(null);
  const [consent, setConsent] = useState(false);
  const [removed, setRemoved] = useState<RemoveResult | null>(null);
  const [resetConfirmed, setResetConfirmed] = useState(false);
  const [resetDone, setResetDone] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const [found, hosts, support] = await Promise.all([bridge.listDriveRecords(), bridge.listFlowTargets(), bridge.resetSupport()]);
      setRecords(found);
      setTargets(hosts);
      setReset(support);
      setDriveId((current) => found.some((item) => item.driveId === current) ? current : found[0]?.driveId ?? "");
      setTargetId((current) => hosts.some((item) => item.id === current) ? current : hosts[0]?.id ?? "");
      setError(null);
    } catch (failure) { setError(message(failure)); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); return () => { void bridge.invalidateFlowPreview(); }; }, [bridge]); // eslint-disable-line react-hooks/exhaustive-deps

  function clearResults() {
    setRefresh(null); setRefreshed(null); setPulled(null); setRemoval(null); setRemoved(null); setConsent(false); setError(null);
    void bridge.invalidateFlowPreview();
  }
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try { await action(); } catch (failure) { setError(message(failure)); } finally { setBusy(false); }
  }
  const scopes = removal?.review.credentials.scopes ?? [];
  const chosen = STEPS.some(([key]) => options[key]);
  const selected = Boolean(driveId);

  return <article className="glass-panel">
    <h1>Manage drives</h1>
    {loading ? <p role="status">Loading drive records</p> : records.length === 0 ? <div className="empty-state" role="status"><h2>No drive records</h2><p>Drives created on this computer appear here.</p></div> : <>
      <div className="toolbar">
        <label htmlFor="manage-drive">Drive</label>
        <select id="manage-drive" value={driveId} disabled={busy} onChange={(event) => { setDriveId(event.target.value); clearResults(); }}>{records.map((item) => <option key={item.driveId} value={item.driveId}>{item.driveId}</option>)}</select>
        <label htmlFor="manage-target">Host</label>
        <select id="manage-target" value={targetId} disabled={busy} onChange={(event) => { setTargetId(event.target.value); clearResults(); }}>{targets.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select>
      </div>
      {error && <p role="alert" className="error-panel">{error}</p>}

      <section aria-labelledby="refresh-heading">
        <h2 id="refresh-heading">Refresh</h2>
        <p>Copy this host's configuration and credentials to the drive.</p>
        <button type="button" disabled={busy || !selected || !targetId} onClick={() => run(async () => { clearResults(); setRefresh(await bridge.previewRefresh(driveId, targetId, { configuration: {}, replacePending: false })); })}>Preview refresh</button>
        {refresh && <div role="status"><p>Status: {refresh.preview.disposition}. {refresh.preview.conflicts.length} conflicts, {refresh.preview.deferredPaths.length} deferred.</p>
          <button type="button" disabled={busy || !["ready", "reusePending"].includes(refresh.preview.disposition)} onClick={() => run(async () => { const result = await bridge.publishRefresh(refresh.previewId); setRefresh(null); setRefreshed(result); })}>Publish refresh</button></div>}
        {refreshed && <p role="status">Refresh published{refreshed.sequence !== null ? ` as bundle ${refreshed.sequence}` : ""}.</p>}
      </section>

      <section aria-labelledby="logs-heading">
        <h2 id="logs-heading">Pull logs</h2>
        <p>Merge the drive's session logs into the selected host.</p>
        <button type="button" disabled={busy || !selected || !targetId} onClick={() => run(async () => { clearResults(); setPulled(await bridge.pullLogs(driveId, targetId)); })}>Pull logs</button>
        {pulled && <p role="status">{pulled.imported} imported, {pulled.duplicates} already present, {pulled.conflicts.length} conflicts{pulled.truncated ? "; the drive's log capture was truncated" : ""}{pulled.complete ? "." : "; run again after resolving conflicts."}</p>}
      </section>

      <section aria-labelledby="remove-heading">
        <h2 id="remove-heading">Remove instance</h2>
        <fieldset disabled={busy}><legend>Steps</legend>
          {STEPS.map(([key, label]) => <div key={key}><input id={`remove-${key}`} type="checkbox" checked={options[key]} onChange={(event) => { setOptions({ ...options, [key]: event.target.checked }); setRemoval(null); setRemoved(null); setConsent(false); }} /><label htmlFor={`remove-${key}`}>{label}</label></div>)}
        </fieldset>
        <button type="button" disabled={busy || !selected || !chosen} onClick={() => run(async () => { setRemoved(null); setConsent(false); setRemoval(await bridge.previewRemoval(driveId, options, false)); })}>Review removal</button>
        {removal && <div role="status">
          <p>Selected steps will run in order. Each is reported separately.</p>
          {removal.review.options.eraseStorage && !removal.review.eraseSupport.supported && <p role="alert">{removal.review.eraseSupport.reason}</p>}
          {scopes.length > 0 && <><ul>{scopes.map((scope) => <li key={scope.handle}>{scope.provider}: shared with {scope.affectedIdentities.join(", ")}</li>)}</ul>
            <input id="remove-consent" type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} /><label htmlFor="remove-consent">I understand these identities lose access</label></>}
          <button type="button" disabled={busy || (scopes.length > 0 && !consent)} onClick={() => run(async () => { const result = await bridge.executeRemoval(removal.previewId, removal.review.digest, consent ? scopes.flatMap((scope) => scope.affectedIdentities) : [], { retryFailedLogs: false, continueWithoutLogs: false }); setRemoval(null); setRemoved(result); })}>Remove</button>
        </div>}
        {removed && <ul role="status"><li>Logs: {describe(removed.pullLogs)}</li><li>Storage: {describe(removed.eraseStorage)}</li><li>Credentials: {describe(removed.revokeCredentials)}</li><li>Forget: {describe(removed.forgetDrive)}</li>{removed.pausedForLogs && <li>Paused because logs could not be pulled. Review the removal again to retry.</li>}</ul>}
      </section>

      <section aria-labelledby="reset-heading">
        <h2 id="reset-heading">Reset storage</h2>
        <p>Erase the drive's persistent storage so it can be set up again with a new passphrase.</p>
        {reset && !reset.supported && <p role="alert">{reset.reason}</p>}
        <input id="reset-confirm" type="checkbox" checked={resetConfirmed} disabled={busy || !reset?.supported} onChange={(event) => setResetConfirmed(event.target.checked)} /><label htmlFor="reset-confirm">I understand this permanently erases the drive's persistent data</label>
        <button type="button" disabled={busy || !reset?.supported || !resetConfirmed} onClick={() => run(async () => { await bridge.resetStorage(); setResetConfirmed(false); setResetDone(true); })}>Reset storage</button>
        {resetDone && <p role="status">Storage was reset.</p>}
      </section>
    </>}
  </article>;
}
