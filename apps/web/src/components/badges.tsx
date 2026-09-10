import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import type { AuthState } from "@/types/api";

/** Per-tool accent dots: subtle brand-adjacent hues on a neutral chip. */
const TOOL_DOT_CLASSES: Record<string, string> = {
  claude: "bg-orange-400",
  codex: "bg-emerald-400",
  grok: "bg-zinc-200",
  kimi: "bg-sky-400",
  zai: "bg-violet-400",
  ali: "bg-amber-400",
  pi: "bg-pink-400",
  opencode: "bg-teal-400",
};

export function ToolBadge({ tool, className }: { tool: string; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-md border bg-secondary/50 px-1.5 py-0.5 font-mono text-xs",
        className,
      )}
    >
      <span
        aria-hidden
        className={cn("size-1.5 rounded-full", TOOL_DOT_CLASSES[tool] ?? "bg-muted-foreground")}
      />
      {tool}
    </span>
  );
}

export function IdentityChip({ name, className }: { name: string; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex max-w-48 shrink-0 items-center gap-1 truncate rounded-md border px-1.5 py-0.5 text-xs font-medium",
        className,
      )}
      title={name}
    >
      {name}
    </span>
  );
}

/** Logged in / expiring / expired / missing / unknown, from GET /api/auth. */
export function AuthStateBadge({ state, className }: { state: AuthState; className?: string }) {
  switch (state) {
    case "ok":
      return (
        <Badge variant="success" className={className}>
          Logged in
        </Badge>
      );
    case "expiring":
      return (
        <Badge variant="warning" className={className}>
          Expiring
        </Badge>
      );
    case "expired":
      return (
        <Badge variant="destructive" className={className}>
          Expired
        </Badge>
      );
    case "missing":
      return (
        <Badge variant="muted" className={className}>
          Not logged in
        </Badge>
      );
    default:
      return (
        <Badge variant="secondary" className={className}>
          Unknown
        </Badge>
      );
  }
}
