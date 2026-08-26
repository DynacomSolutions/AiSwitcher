import { useTicker } from "@/hooks/use-ticker";
import { relSeconds, relTime } from "@/lib/format";
import { cn } from "@/lib/utils";

/** "Updated 4s ago" label driven by react-query's dataUpdatedAt. */
export function UpdatedAgo({
  updatedAt,
  className,
}: {
  updatedAt?: number;
  className?: string;
}) {
  const now = useTicker(1000);
  if (!updatedAt) return null;
  const seconds = Math.max(0, Math.round((now - updatedAt) / 1000));
  return (
    <span className={cn("text-xs whitespace-nowrap text-muted-foreground tabular-nums", className)}>
      Updated {relSeconds(seconds)}
    </span>
  );
}

/** Relative timestamp that keeps itself fresh. */
export function RelativeTime({ iso, className }: { iso: string; className?: string }) {
  const now = useTicker(1000);
  return (
    <span className={className} title={iso}>
      {relTime(iso, now)}
    </span>
  );
}
