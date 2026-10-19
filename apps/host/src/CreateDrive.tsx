import { useEffect, useState } from "react";
import type { DeviceSummary, HostBridge, ModelChoice, WritePreview } from "./contract";

export function isEligible(device: DeviceSummary): boolean {
  return !device.system && device.writable && device.transport === "usb";
}

export function formatSize(bytes: number): string {
  if (bytes >= 1e12) return `${(bytes / 1e12).toFixed(1)} TB`;
  return `${Math.round(bytes / 1e9)} GB`;
}

function messageOf(error: unknown): string {
  if (typeof error === "string") return error;
  return error instanceof Error ? error.message : "The request failed. Refresh the drive list and try again.";
}

/** Remount it with a new `key` to drop the preview and typed text after a refresh. */
export function CreateDrive({ bridge, devices, loading, onRefresh }: { bridge: HostBridge; devices: DeviceSummary[]; loading: boolean; onRefresh: () => void }) {
  const eligible = devices.filter(isEligible);
  const [selectedId, setSelectedId] = useState("");
  const [preview, setPreview] = useState<WritePreview | null>(null);
  const [typed, setTyped] = useState("");
  const [confirmedFor, setConfirmedFor] = useState<number | null>(null);
  const [expired, setExpired] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [models, setModels] = useState<ModelChoice[]>([]);
  const [wantModel, setWantModel] = useState(false);
  const [modelId, setModelId] = useState("");
  const [licenceAccepted, setLicenceAccepted] = useState(false);
  const [passphrase, setPassphrase] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const model = models.find((item) => item.id === modelId);
  const selected = eligible.find((device) => device.id === selectedId);

  useEffect(() => {
    let alive = true;
    void bridge.listModels().then((list) => { if (alive) setModels(list); }).catch(() => { if (alive) setModels([]); });
    return () => { alive = false; };
  }, [bridge]);
  // The native ticket outlives the view unless told otherwise.
  useEffect(() => () => { void bridge.invalidateConfirmation(); }, [bridge]);
  useEffect(() => {
    if (confirmedFor === null) return;
    const timer = setTimeout(() => {
      setConfirmedFor(null);
      setExpired(true);
      setError("Confirmation expired. Preview the device again to continue.");
      void bridge.invalidateConfirmation();
    }, confirmedFor * 1000);
    return () => clearTimeout(timer);
  }, [bridge, confirmedFor]);

  function choose(id: string) {
    setSelectedId(id);
    setPreview(null);
    setTyped("");
    setConfirmedFor(null);
    setExpired(false);
    setError(null);
    void bridge.invalidateConfirmation();
  }

  function optionsProblem(): string | null {
    if (passphrase.length < 12) return "The passphrase must be at least 12 characters.";
    if (passphrase !== confirmation) return "The passphrase and its confirmation differ.";
    if (wantModel && !model) return "Choose a model, or decline the optional download.";
    if (wantModel && !licenceAccepted) return "Accept the model licence to include the model.";
    return null;
  }

  async function requestPreview() {
    const problem = optionsProblem();
    setOptionsError(problem);
    if (problem) return;
    setError(null);
    setExpired(false);
    setTyped("");
    setConfirmedFor(null);
    try {
      await bridge.setCreateOptions(wantModel ? modelId : null, wantModel && licenceAccepted, passphrase, confirmation);
      setPreview(await bridge.previewWrite(selectedId));
    } catch (failure) { setPreview(null); setError(messageOf(failure)); }
    // Native code holds the validated copy; clear the fields promptly.
    setPassphrase("");
    setConfirmation("");
  }

  async function confirm() {
    if (!preview) return;
    // The native side compares exactly and drops any earlier ticket on a mismatch.
    try {
      const receipt = await bridge.confirmWrite(preview.previewId, typed);
      setError(null);
      setConfirmedFor(receipt.expiresInSeconds);
    } catch (failure) {
      setConfirmedFor(null);
      setError(typed !== preview.displayIdentifier ? "Type the exact displayed device identifier." : messageOf(failure));
    }
  }

  async function write() {
    if (!preview) return;
    try { await bridge.startWrite(preview.previewId); } catch (failure) { setError(messageOf(failure)); }
    setConfirmedFor(null);
  }

  return <article className="glass-panel">
    <h1>Create a drive</h1>
    <div className="toolbar">
      <label htmlFor="target-device">Target device</label>
      <select id="target-device" value={selectedId} onChange={(event) => choose(event.target.value)} aria-describedby="target-help">
        <option value="">{loading ? "Loading devices" : "Choose a removable drive"}</option>
        {eligible.map((device) => <option key={device.id} value={device.id}>{device.displayIdentifier} ({formatSize(device.capacityBytes)})</option>)}
      </select>
      <button type="button" onClick={onRefresh}>Refresh devices</button>
    </div>
    <p id="target-help">Only removable drives that are not in use by this computer are listed.</p>
    {!loading && eligible.length === 0 && <div className="empty-state" role="status"><h2>No eligible drive</h2><p>Connect a removable USB drive, then refresh the list.</p></div>}
    {selected && <dl className="identity" aria-label="Selected device">
      <dt>Model</dt><dd>{selected.model ?? "Unknown"}</dd>
      <dt>Size</dt><dd>{formatSize(selected.capacityBytes)}</dd>
      <dt>Connection</dt><dd>{selected.transport.toUpperCase()}</dd>
      <dt>Serial</dt><dd>{selected.serial ?? "Not reported"}</dd>
    </dl>}
    <fieldset className="options">
      <legend>Drive options</legend>
      <label htmlFor="drive-passphrase">Passphrase</label>
      <input id="drive-passphrase" type="password" autoComplete="new-password" spellCheck={false} value={passphrase} onChange={(event) => setPassphrase(event.target.value)} aria-describedby="passphrase-help" />
      <label htmlFor="drive-passphrase-confirm">Confirm passphrase</label>
      <input id="drive-passphrase-confirm" type="password" autoComplete="new-password" spellCheck={false} value={confirmation} onChange={(event) => setConfirmation(event.target.value)} />
      <p id="passphrase-help">At least 12 characters. First boot uses it to create the encrypted persistent storage. It is kept for this session only.</p>
      <fieldset>
        <legend>Include a local model</legend>
        <label><input type="radio" name="model-choice" checked={!wantModel} onChange={() => { setWantModel(false); setLicenceAccepted(false); }} /> No, do not download a model</label>
        <label><input type="radio" name="model-choice" checked={wantModel} disabled={models.length === 0} onChange={() => setWantModel(true)} /> Yes, include a pinned model{models.length === 0 ? " (none available in this build)" : ""}</label>
        {wantModel && <>
          <label htmlFor="model-select">Model</label>
          <select id="model-select" value={modelId} onChange={(event) => { setModelId(event.target.value); setLicenceAccepted(false); }}>
            <option value="">Choose a model</option>
            {models.map((item) => <option key={item.id} value={item.id}>{item.name} ({item.quality}, {formatSize(item.sizeBytes)})</option>)}
          </select>
          {model && <section aria-label="Model licence"><h3>{model.licenceName}</h3><pre className="licence" tabIndex={0}>{model.licenceText}</pre>
            <label><input type="checkbox" checked={licenceAccepted} onChange={(event) => setLicenceAccepted(event.target.checked)} /> I accept this licence</label></section>}
        </>}
      </fieldset>
      {optionsError && <p role="alert" className="error-panel">{optionsError}</p>}
    </fieldset>
    <button type="button" className="primary-button" disabled={!selected} onClick={() => void requestPreview()}>Preview create layout</button>
    {!preview && error && <p role="alert" className="error-panel">{error}</p>}
    {preview && <section className="disk-confirmation" aria-label="Device preview">
      <h2>Review before writing</h2>
      <p>This replaces everything on the drive.</p>
      <dl>
        <dt>Operation</dt><dd>{preview.operation === "createLayout" ? "Create layout" : preview.operation}</dd>
        <dt>Device</dt><dd data-testid="device-identifier">{preview.displayIdentifier}</dd>
        <dt>Size</dt><dd>{formatSize(preview.capacityBytes)}</dd>
        <dt>Preview</dt><dd data-testid="preview-id">{preview.previewId}</dd>
        <dt>Image digest</dt><dd>{preview.imageDigest}</dd>
      </dl>
      <h3>Current partitions</h3>
      {preview.partitionDetailsAvailable ? preview.partitions.length === 0 ? <p>No partitions found.</p> : <ul>{preview.partitions.map((part) => <li key={part.name}>{part.name}: {part.kind}, {formatSize(part.sizeBytes)}</li>)}</ul> : <p>Partition details are unavailable for this drive.</p>}
      <label htmlFor="confirm-identifier">Type the device identifier to confirm</label>
      <input id="confirm-identifier" autoFocus autoComplete="off" spellCheck={false} value={typed} disabled={expired} onChange={(event) => { setTyped(event.target.value); setConfirmedFor(null); }} aria-invalid={error !== null} />
      <button type="button" disabled={expired || confirmedFor !== null} onClick={() => void confirm()}>Confirm create layout</button>
      <button type="button" className="primary-button" disabled={confirmedFor === null} onClick={() => void write()}>Write to drive</button>
      {confirmedFor !== null && <p role="status">Confirmation expires in {confirmedFor} seconds</p>}
      {error && <p role="alert" className="error-panel">{error}</p>}
    </section>}
  </article>;
}
