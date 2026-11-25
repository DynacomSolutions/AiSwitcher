import { useTicker } from "@/hooks/use-ticker";
import { countdownUntil } from "@/lib/format";
import { cn } from "@/lib/utils";

/** Relative countdown beside the local and UK reset times. It ticks every 30 seconds. It never breaks over two lines. */
export function ResetCountdown({ ms, className }: { ms: number; className?: string }) {
  const now = useTicker(30_000);
  const countdown = countdownUntil(ms, now);
  return (
    <span data-slot="reset-countdown" className={cn("shrink-0 whitespace-nowrap", className)}>
      {countdown === "now" ? "now" : `in ${countdown}`}
    </span>
  );
}
