import { useQueryClient, type QueryKey } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { qk } from "@/hooks/queries";
import { listenToConsoleEvents } from "@/lib/console-events";

const queries = new Map<string, QueryKey>([
  ["limits", qk.limits],
  ["usage", qk.usage],
  ["pools-usage", qk.poolsUsage],
  ["gateway-usage", qk.gatewayUsage(7)],
  ["usage-projects", qk.usageProjects],
  ["codex-auto-reset", qk.autoReset],
]);

export function useConsoleEvents(): boolean {
  const client = useQueryClient();
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const lifetime = new AbortController();
    const refresh = (topics: Iterable<string>) => {
      for (const topic of new Set(topics)) {
        const queryKey = queries.get(topic);
        if (queryKey) void client.invalidateQueries({ queryKey, exact: true });
      }
    };
    void listenToConsoleEvents({
      onReady(reconnecting) {
        if (reconnecting) refresh(queries.keys());
        setConnected(true);
      },
      onDisconnect: () => setConnected(false),
      onChange: refresh,
    }, lifetime.signal);
    return () => lifetime.abort();
  }, [client]);

  return connected;
}
