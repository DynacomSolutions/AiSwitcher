import { cn } from "@/lib/utils";
import { ProviderIcon } from "@/components/provider-icon";
import { Badge } from "@/components/ui/badge";
import type { AuthState } from "@/types/api";

export function ToolBadge({ tool, className }: { tool: string; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-md border bg-secondary/50 px-1.5 py-0.5 font-mono text-xs",
        className,
      )}
    >
      <ProviderIcon provider={tool} size={12} />
      {tool}
    </span>
  );
}

export function IdentityChip({
  name,
  colour,
  className,
}: {
  name: string;
  /** Effective identity colour (#rrggbb); renders a matching dot when set. */
  colour?: string;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex max-w-48 shrink-0 items-center gap-1 truncate rounded-md border px-1.5 py-0.5 text-xs font-medium",
        className,
      )}
      title={name}
    >
      {colour ? <IdentityDot colour={colour} /> : null}
      {name}
    </span>
  );
}

/** Small round identity-colour marker. */
export function IdentityDot({ colour, className }: { colour: string; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("inline-block size-2 shrink-0 rounded-full", className)}
      style={{ backgroundColor: colour }}
    />
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
    case "gateway":
      return (
        <Badge variant="muted" className={className}>
          Via gateway
        </Badge>
      );
    case "retired":
      return (
        <Badge variant="muted" className={className}>
          Retired
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
