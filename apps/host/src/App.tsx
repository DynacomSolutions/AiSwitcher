import { useEffect, useState } from "react";
import { Link, Navigate, Route, Routes, useLocation, useNavigate, useParams } from "react-router-dom";
import type { DeviceSummary, HostBridge, OperationView } from "./contract";
import { contentRoute, filterRoute } from "./routes";
import { acceptOperationProgress } from "./operation";

export function App({ bridge }: { bridge: HostBridge }) {
  const [devices, setDevices] = useState<DeviceSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeOperation, setActiveOperation] = useState<OperationView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [subscriptionError, setSubscriptionError] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let alive = true;
    setSubscriptionError(false);
    void bridge.reportReady();
    void bridge.listDevices().then((result) => { if (alive) { setDevices(result); setLoadError(null); setLoading(false); } }).catch(() => {
      if (alive) { setLoadError("The host runtime is unavailable. Reopen the app and try again."); setLoading(false); }
    });
    const unsubscribe = bridge.subscribeToOperations((next) => {
      setActiveOperation((current) => acceptOperationProgress(current, next));
    }, () => { if (alive) setSubscriptionError(true); });
    return () => { alive = false; unsubscribe(); };
  }, [bridge, reload]);

  return <main className="app-shell">
    <header className="topbar"><Link className="brand" to="/drives" aria-label="ais Host home">ais Host</Link><span>Portable drive manager</span></header>
    <div className="layout">
      <nav aria-label="Main navigation" className="navigation"><Link to="/drives">Drives</Link><Link to="/create">Create</Link><Link to="/settings">Settings</Link></nav>
      <section className="content" aria-live="off">
        {subscriptionError && <p role="alert" className="error-panel">Live operation updates are unavailable. Reopen the app to restore updates.</p>}
        <Routes>
          <Route path="/" element={<Navigate to="/drives" replace />} />
          <Route path="/drives" element={loadError ? <Page title="Drives"><div role="alert" className="error-panel"><p>{loadError}</p><button type="button" onClick={() => { setLoading(true); setReload((value) => value + 1); }}>Retry</button></div></Page> : <DriveList devices={devices} loading={loading} />} />
          <Route path="/drives/:id" element={<DriveDetail devices={devices} loading={loading} />} />
          <Route path="/create" element={<Page title="Create a drive"><p>Connect a removable drive to begin.</p></Page>} />
          <Route path="/settings" element={<Page title="Settings"><p>Host app settings.</p></Page>} />
          <Route path="*" element={<Page title="Page not found"><Link to="/drives">Return to drives</Link></Page>} />
        </Routes>
        {activeOperation && <div className="operation" role="status" aria-live="polite"><span>Operation {activeOperation.phase}: {activeOperation.completedBytes} of {activeOperation.totalBytes ?? "unknown"} bytes</span>{activeOperation.totalBytes !== null && <progress aria-label="Operation progress" max={activeOperation.totalBytes || 1} value={Math.min(activeOperation.completedBytes, activeOperation.totalBytes)} />}</div>}
      </section>
    </div>
  </main>;
}

function DriveList({ devices, loading }: { devices: DeviceSummary[]; loading: boolean }) {
  const location = useLocation();
  const navigate = useNavigate();
  const status = new URLSearchParams(location.search).get("status") ?? "all";
  const shown = status === "all" ? devices : devices.filter((item) => item.layoutStatus === status);
  return <Page title="Drives">
    <div className="toolbar"><label htmlFor="drive-status">Filter drives</label><select id="drive-status" value={status} onChange={(event) => navigate(filterRoute(location.pathname, "status", event.target.value === "all" ? null : event.target.value, location.search), { replace: true })}>
      <option value="all">All</option><option value="ready">Ready</option><option value="unknown">Needs review</option>
    </select><Link className="primary-button" to="/create">Create a drive</Link></div>
    {loading ? <div className="empty-state" role="status">Loading drives</div> : shown.length === 0 ? <div className="empty-state" role="status"><h2>No drives detected</h2><p>Connect a removable drive, or create one to get started.</p></div> : <ul className="drive-list">{shown.map((drive) => <li key={drive.id}><Link to={contentRoute(drive.id)}>{drive.displayIdentifier}</Link><span>{drive.layoutStatus}</span></li>)}</ul>}
  </Page>;
}

function DriveDetail({ devices, loading }: { devices: DeviceSummary[]; loading: boolean }) {
  const { id = "" } = useParams();
  const drive = devices.find((device) => device.id === id);
  if (loading) return <Page title="Loading drive"><p role="status">Checking connected drives</p></Page>;
  if (!drive) return <Page title="Drive unavailable"><div className="error-panel" role="alert"><p>This drive is not available. Reconnect it and refresh the drive list.</p><Link to="/drives">Return to drives</Link></div></Page>;
  return <Page title={drive.displayIdentifier}><p>{drive.model ?? "Removable drive"}</p><Link to="/drives">Back to drives</Link></Page>;
}

function Page({ title, children }: { title: string; children: React.ReactNode }) {
  return <article className="glass-panel"><h1>{title}</h1>{children}</article>;
}
