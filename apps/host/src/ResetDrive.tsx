import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { DeviceSummary, HostBridge, WritePreview } from "./contract";
import { isEligible } from "./CreateDrive";

export function ResetDrive({ bridge, devices, loading }: { bridge: HostBridge; devices: DeviceSummary[]; loading: boolean }) {
  const { id = "" } = useParams();
  return <ResetDriveForm key={id} id={id} bridge={bridge} devices={devices} loading={loading} />;
}

export function canReset(drive: DeviceSummary) {
  return isEligible(drive) && drive.layoutStatus === "ready";
}

function ResetDriveForm({ id, bridge, devices, loading }: { id: string; bridge: HostBridge; devices: DeviceSummary[]; loading: boolean }) {
  const selected = devices.find((item) => item.id === id);
  const drive = selected && canReset(selected) ? selected : undefined;
  const [preview, setPreview] = useState<WritePreview | null>(null);
  const [typed, setTyped] = useState("");
  const [confirmedFor, setConfirmedFor] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => () => { void bridge.invalidateConfirmation(); }, [bridge, id]);
  useEffect(() => {
    if (confirmedFor === null) return;
    const timer = setTimeout(() => {
      setConfirmedFor(null);
      setPreview(null);
      setError("Confirmation expired. Preview the reset again.");
      void bridge.invalidateConfirmation();
    }, confirmedFor * 1000);
    return () => clearTimeout(timer);
  }, [bridge, confirmedFor]);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try { await action(); }
    catch (failure) { setError(typeof failure === "string" ? failure : failure instanceof Error ? failure.message : "The reset failed. Preview again to retry."); }
    finally { setBusy(false); }
  }
  async function requestPreview() {
    setPreview(null);
    setTyped("");
    setConfirmedFor(null);
    await run(async () => {
      const next = await bridge.previewReset(id);
      if (next.operation !== "resetPersist") throw new Error("A storage reset preview is required.");
      setPreview(next);
    });
  }
  async function confirm() {
    if (!preview) return;
    setConfirmedFor(null);
    await run(async () => {
      const receipt = await bridge.confirmWrite(preview.previewId, typed);
      setConfirmedFor(receipt.expiresInSeconds);
    });
  }
  async function write() {
    if (!preview || confirmedFor === null) return;
    setConfirmedFor(null);
    const previewId = preview.previewId;
    setPreview(null);
    await run(async () => { await bridge.startWrite(previewId); setDone(true); });
  }
  return <article className="glass-panel">
    <h1>Reset storage</h1>
    <Link to="/drives">Back to drives</Link>
    {loading ? <p role="status">Checking connected drives</p> : !drive ? <p role="alert">{selected?.updateError ?? "Connect a ready drive created on this computer to reset its storage."}</p> : <>
      <h2>{drive.displayIdentifier}</h2>
      <p>Erases the drive's encrypted storage and its keys. Nothing in it can be recovered, with or without the passphrase. Boot, base and exchange partitions are not changed. The next boot asks for a new passphrase and creates the storage again.</p>
      {!done && <button type="button" disabled={busy} onClick={() => void requestPreview()}>Preview reset</button>}
      {preview && <section className="disk-confirmation" aria-label="Reset preview">
        <h2>Review storage reset</h2>
        <dl>
          <dt>Device</dt><dd data-testid="device-identifier">{preview.displayIdentifier}</dd>
          <dt>Model</dt><dd>{preview.model ?? "Unknown"}</dd>
          <dt>Serial</dt><dd>{preview.serial ?? "Not reported"}</dd>
          <dt>Connection</dt><dd>{preview.connectionIdentity}</dd>
          <dt>Capacity</dt><dd>{preview.capacityBytes.toLocaleString()} bytes</dd>
        </dl>
        <p>Erases only the header area of the encrypted storage partition.</p>
        {preview.partitions.map((part) => <p key={part.name}>{part.name}: {part.sizeBytes.toLocaleString()} bytes {part.kind === "erase" ? "will be erased" : "kept"}.</p>)}
        <label htmlFor="reset-identifier">Type the device identifier to confirm</label>
        <input id="reset-identifier" autoComplete="off" spellCheck={false} disabled={busy} value={typed} onChange={(event) => { setTyped(event.target.value); setConfirmedFor(null); }} />
        <button type="button" disabled={busy || confirmedFor !== null} onClick={() => void confirm()}>Confirm storage reset</button>
        <button type="button" disabled={busy || confirmedFor === null} onClick={() => void write()}>Erase storage</button>
        {confirmedFor !== null && <p role="status">Confirmation expires in {confirmedFor} seconds</p>}
      </section>}
      {busy && <p role="status">Working on the storage reset</p>}
      {done && <p role="status">Storage erased and read back. Boot the drive to set a new passphrase.</p>}
    </>}
    {error && <p role="alert" className="error-panel">{error}</p>}
  </article>;
}
