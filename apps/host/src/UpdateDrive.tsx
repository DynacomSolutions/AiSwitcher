import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { DeviceSummary, HostBridge, WritePreview } from "./contract";
import { isEligible } from "./CreateDrive";

export function UpdateDrive({ bridge, devices, loading }: { bridge: HostBridge; devices: DeviceSummary[]; loading: boolean }) {
  const { id = "" } = useParams();
  return <UpdateDriveForm key={id} id={id} bridge={bridge} devices={devices} loading={loading} />;
}

export function canUpdate(drive: DeviceSummary) {
  return isEligible(drive) && ["ready", "update incomplete", "awaiting boot"].includes(drive.layoutStatus);
}

function UpdateDriveForm({ id, bridge, devices, loading }: { id: string; bridge: HostBridge; devices: DeviceSummary[]; loading: boolean }) {
  const drive = devices.find((item) => item.id === id && canUpdate(item));
  const [passphrase, setPassphrase] = useState("");
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
      setError("Confirmation expired. Preview the update again.");
      void bridge.invalidateConfirmation();
    }, confirmedFor * 1000);
    return () => clearTimeout(timer);
  }, [bridge, confirmedFor]);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try { await action(); }
    catch (failure) { setError(typeof failure === "string" ? failure : failure instanceof Error ? failure.message : "The update failed. Preview again to retry."); }
    finally { setBusy(false); }
  }
  async function requestPreview() {
    setPreview(null);
    setTyped("");
    setConfirmedFor(null);
    await run(async () => {
      await bridge.setCreateOptions(null, false, passphrase, passphrase);
      setPassphrase("");
      const next = await bridge.previewUpdate(id);
      if (next.operation !== "replaceBase") throw new Error("An image update preview is required.");
      setPreview(next);
    });
    setPassphrase("");
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
    <h1>Update drive image</h1>
    <Link to="/drives">Back to drives</Link>
    {loading ? <p role="status">Checking connected drives</p> : !drive ? <p role="alert">Connect a known, writable USB drive to update its image.</p> : <>
      <h2>{drive.displayIdentifier}</h2>
      {drive.layoutStatus === "update incomplete" && <p role="alert">An earlier update did not finish. Preview and confirm a retry before booting this drive.</p>}
      {drive.layoutStatus === "awaiting boot" && <p>The previous image update was written. Package restoration still needs verification after boot.</p>}
      <p>Replace the boot and base image with a verified newer release. Encrypted storage and drive identities are preserved. A small encrypted notification is added to the exchange inbox.</p>
      <p>The drive reinstalls its recorded packages on next boot. Keep it connected until the update finishes; an interrupted write can leave it unable to boot until retried.</p>
      {!done && <fieldset disabled={busy}>
        <legend>Existing drive passphrase</legend>
        <label htmlFor="update-passphrase">Passphrase</label>
        <input id="update-passphrase" type="password" autoComplete="current-password" value={passphrase} onChange={(event) => { setPassphrase(event.target.value); setPreview(null); setConfirmedFor(null); void bridge.invalidateConfirmation(); }} />
        <button type="button" disabled={passphrase.length < 12} onClick={() => void requestPreview()}>Preview update</button>
      </fieldset>}
      {preview && <section className="disk-confirmation" aria-label="Update preview">
        <h2>Review image update</h2>
        <dl>
          <dt>Device</dt><dd data-testid="device-identifier">{preview.displayIdentifier}</dd>
          <dt>Model</dt><dd>{preview.model ?? "Unknown"}</dd>
          <dt>Serial</dt><dd>{preview.serial ?? "Not reported"}</dd>
          <dt>Connection</dt><dd>{preview.connectionIdentity}</dd>
          <dt>Capacity</dt><dd>{preview.capacityBytes.toLocaleString()} bytes</dd>
          <dt>Image digest</dt><dd>{preview.imageDigest}</dd>
        </dl>
        <p>Writes only BIOS, boot and base partitions.</p>
        {preview.partitions.filter((part) => part.kind === "preserve").map((part) => <p key={part.name}>{part.name}: {part.sizeBytes.toLocaleString()} bytes preserved by the image writer.</p>)}
        <label htmlFor="update-identifier">Type the device identifier to confirm</label>
        <input id="update-identifier" autoComplete="off" spellCheck={false} disabled={busy} value={typed} onChange={(event) => { setTyped(event.target.value); setConfirmedFor(null); }} />
        <button type="button" disabled={busy || confirmedFor !== null} onClick={() => void confirm()}>Confirm image update</button>
        <button type="button" disabled={busy || confirmedFor === null} onClick={() => void write()}>Write update</button>
        {confirmedFor !== null && <p role="status">Confirmation expires in {confirmedFor} seconds</p>}
      </section>}
      {busy && <p role="status">Working on the image update</p>}
      {done && <p role="status">Image and inbox marker verified. Boot the drive to restore its recorded packages.</p>}
    </>}
    {error && <p role="alert" className="error-panel">{error}</p>}
  </article>;
}
