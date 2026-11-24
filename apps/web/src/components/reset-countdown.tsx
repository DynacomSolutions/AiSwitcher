import { useTicker } from "@/hooks/use-ticker";
import { countdownUntil } from "@/lib/format";

/** Relative countdown beside the local and UK reset times. It ticks every 30 seconds. */
export function ResetCountdown({ ms, className }: { ms: number; className?: string }) {
  const now = useTicker(30_000);
  const countdown = countdownUntil(ms, now);
  return <span className={className}>{countdown === "now" ? "now" : `in ${countdown}`}</span>;
}