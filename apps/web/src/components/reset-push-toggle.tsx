import { BellOff, BellRing } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { api } from "@/lib/api";

type PushState = "loading" | "unsupported" | "denied" | "off" | "on";

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const pad = "=".repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob((base64url + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function sameKey(a: ArrayBuffer | null | undefined, b: Uint8Array): boolean {
  if (!a) return false;
  const x = new Uint8Array(a);
  return x.length === b.length && x.every((v, i) => v === b[i]);
}

/** The service worker registration, when the console runs as an installed or installable PWA (production build). */
async function registration(): Promise<ServiceWorkerRegistration | undefined> {
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return undefined;
  return (await navigator.serviceWorker.getRegistration()) ?? undefined;
}

function unsupportedReason(): string {
  if (!window.isSecureContext) return "Notifications need the console on HTTPS.";
  if (/iPhone|iPad/.test(navigator.userAgent) && !window.matchMedia("(display-mode: standalone)").matches) {
    return "On iPhone and iPad, add the console to the Home Screen first, then turn notifications on from there.";
  }
  return "This browser cannot receive push notifications here.";
}

/**
 * Turns reset-expiry push notifications on or off for this browser. The daemon
 * sends one when an unspent Claude or Codex reset is 7 days from expiry, then 3
 * days, then 24 hours.
 */
export function ResetPushToggle() {
  const [state, setState] = useState<PushState>("loading");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const reg = await registration();
    if (!reg) return setState("unsupported");
    if (Notification.permission === "denied") return setState("denied");
    const sub = await reg.pushManager.getSubscription();
    if (!sub) return setState("off");
    // Re-register on every visit: the daemon may have dropped it, or its keys changed.
    try {
      const { publicKey } = await api.getPush();
      if (!sameKey(sub.options.applicationServerKey, keyBytes(publicKey))) {
        await sub.unsubscribe();
        return setState("off");
      }
      await api.subscribePush(sub.toJSON());
      setState("on");
    } catch {
      setState("on");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const turnOn = async () => {
    setBusy(true);
    try {
      const reg = await registration();
      if (!reg) return setState("unsupported");
      const permission = await Notification.requestPermission();
      if (permission !== "granted") return setState(permission === "denied" ? "denied" : "off");
      const { publicKey } = await api.getPush();
      const key = keyBytes(publicKey);
      let sub = await reg.pushManager.getSubscription();
      if (sub && !sameKey(sub.options.applicationServerKey, key)) {
        await sub.unsubscribe();
        sub = null;
      }
      sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      await api.subscribePush(sub.toJSON());
      setState("on");
      toast.success("Reset reminders on", { description: "You will get a notification 7 days, 3 days and 24 hours before a reset expires." });
    } catch (error) {
      toast.error("Could not turn on notifications", { description: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  };

  const turnOff = async () => {
    setBusy(true);
    try {
      const sub = await (await registration())?.pushManager.getSubscription();
      if (sub) {
        await api.unsubscribePush(sub.endpoint).catch(() => undefined);
        await sub.unsubscribe();
      }
      setState("off");
    } catch (error) {
      toast.error("Could not turn off notifications", { description: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  };

  const sendTest = async () => {
    setBusy(true);
    try {
      const r = await api.testPush();
      if (r.sent > 0) toast.success("Test notification sent");
      else toast.error("No device took the test notification", { description: r.failed > 0 ? "The push service refused it; see the daemon log." : "Turn notifications off and on again." });
    } catch (error) {
      toast.error("Test failed", { description: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  };

  if (state === "loading") return null;
  const on = state === "on";
  return (
    <Card className="py-3">
      <CardContent className="flex flex-wrap items-center justify-between gap-3 px-4">
        <div className="flex min-w-0 items-start gap-2 text-sm">
          {on ? <BellRing aria-hidden className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400" /> : <BellOff aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />}
          <div className="min-w-0">
            <div className="font-medium">Reset expiry notifications</div>
            <div className="text-xs text-muted-foreground">
              {state === "unsupported"
                ? unsupportedReason()
                : state === "denied"
                  ? "Notifications are blocked for this site. Allow them in the browser's site settings."
                  : on
                    ? "On for this device: 7 days, 3 days and 24 hours before an unspent reset expires."
                    : "Get a notification 7 days, 3 days and 24 hours before an unspent Claude or Codex reset expires."}
            </div>
          </div>
        </div>
        {state === "off" ? (
          <Button size="sm" disabled={busy} onClick={() => void turnOn()}>
            Turn on
          </Button>
        ) : on ? (
          <div className="flex gap-2">
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void sendTest()}>
              Send test
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void turnOff()}>
              Turn off
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
