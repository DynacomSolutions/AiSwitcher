import { useQueryClient } from "@tanstack/react-query";
import { ChevronRight, RefreshCw } from "lucide-react";
import { useState, type ReactNode } from "react";

import { ToolBadge } from "@/components/badges";
import { EmptyState, ErrorBanner, PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { qk, usePermissionsQuery } from "@/hooks/queries";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import type {
  PermissionCacheStatsDto,
  PermissionCountsDto,
  PermissionGroup,
  PermissionIdentityNode,
  PermissionRepoNode,
  PermissionRulesDto,
  PermissionToolNode,
  PermissionWorktreeNode,
} from "@/types/api";

const GROUPS: { key: PermissionGroup; label: string; bar: string; text: string }[] = [
  { key: "allow", label: "Allow", bar: "bg-emerald-500", text: "text-emerald-600 dark:text-emerald-400" },
  { key: "ask", label: "Ask", bar: "bg-amber-500", text: "text-amber-600 dark:text-amber-400" },
  { key: "deny", label: "Deny", bar: "bg-red-500", text: "text-red-600 dark:text-red-400" },
];

/** Stacked allow / ask / deny bar; empty nodes show a neutral track. */
function CountBar({ counts, className }: { counts: PermissionCountsDto; className?: string }) {
  return (
    <div
      role="img"
      aria-label={`${counts.allow} allow, ${counts.ask} ask, ${counts.deny} deny`}
      className={cn("bg-muted flex h-2 w-full min-w-0 overflow-hidden rounded-full", className)}
    >
      {counts.total > 0
        ? GROUPS.map((g) =>
            counts[g.key] > 0 ? (
              <div key={g.key} className={g.bar} style={{ width: `${(counts[g.key] / counts.total) * 100}%` }} />
            ) : null,
          )
        : null}
    </div>
  );
}

function CountsBadge({ counts }: { counts: PermissionCountsDto }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 font-mono text-xs tabular-nums">
      {GROUPS.map((g) => (
        <span key={g.key} className={counts[g.key] > 0 ? g.text : "text-muted-foreground/60"}>
          {counts[g.key]}
        </span>
      ))}
    </span>
  );
}

function CacheBadge({ cache }: { cache: PermissionCacheStatsDto }) {
  if (cache.hits + cache.misses === 0) return null;
  return (
    <Badge variant="muted" className="font-mono text-[10px]" title="cache hits / misses in this subtree">
      {cache.hits}h/{cache.misses}m
    </Badge>
  );
}

function Node({
  title,
  badge,
  counts,
  cache,
  depth,
  defaultOpen = false,
  children,
}: {
  title: ReactNode;
  badge?: ReactNode;
  counts: PermissionCountsDto;
  cache: PermissionCacheStatsDto;
  depth: number;
  defaultOpen?: boolean;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const expandable = children !== undefined && children !== null && children !== false;
  return (
    <div className={cn(depth > 0 && "border-l pl-2 sm:pl-4")}>
      <button
        type="button"
        disabled={!expandable}
        aria-expanded={expandable ? open : undefined}
        onClick={() => setOpen((v) => !v)}
        className="hover:bg-accent/50 flex w-full min-w-0 flex-col gap-1.5 rounded-md px-2 py-1.5 text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40"
      >
        <span className="flex w-full min-w-0 items-center gap-2">
          <ChevronRight
            aria-hidden
            className={cn("size-4 shrink-0 transition-transform", open && "rotate-90", !expandable && "opacity-20")}
          />
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{title}</span>
          {badge}
          <CacheBadge cache={cache} />
          <CountsBadge counts={counts} />
        </span>
        <CountBar counts={counts} className="ml-6 w-[calc(100%-1.5rem)]" />
      </button>
      {open && expandable ? <div className="mt-1 space-y-1">{children}</div> : null}
    </div>
  );
}

function RuleGroups({ rules }: { rules: PermissionRulesDto }) {
  const total = rules.allow.length + rules.ask.length + rules.deny.length;
  if (total === 0) return <p className="px-2 py-1 text-xs text-muted-foreground">No rules.</p>;
  return (
    <div className="space-y-2 px-2 py-1">
      {GROUPS.map((g) =>
        rules[g.key].length > 0 ? (
          <div key={g.key} className="space-y-1">
            <div className="flex items-center gap-2 text-xs font-medium">
              <span className={cn("size-2 rounded-full", g.bar)} aria-hidden />
              <span>{g.label}</span>
              <span className="text-muted-foreground tabular-nums">{rules[g.key].length}</span>
            </div>
            <ul className="space-y-0.5">
              {rules[g.key].map((rule, index) => (
                <li key={`${index}-${rule}`} className="bg-muted/50 rounded px-2 py-0.5 font-mono text-xs break-all">
                  {rule}
                </li>
              ))}
            </ul>
          </div>
        ) : null,
      )}
    </div>
  );
}

function SourceNotes({ sources }: { sources: { path: string; label: string; exists: boolean; error?: string }[] }) {
  return (
    <ul className="space-y-0.5 px-2 text-[11px] text-muted-foreground">
      {sources.map((s) => (
        <li key={s.path} className="break-all">
          <span className="font-mono">{s.label}</span>
          {s.exists ? null : " (absent)"}
          {s.error ? <span className="text-red-600 dark:text-red-400"> {s.error}</span> : null}
        </li>
      ))}
    </ul>
  );
}

function WorktreeView({ wt }: { wt: PermissionWorktreeNode }) {
  return (
    <Node
      depth={1}
      counts={wt.counts}
      cache={wt.cache}
      title={<span title={wt.path}>{wt.kind === "base" ? "base" : wt.task}</span>}
      badge={wt.kind === "base" ? <Badge variant="outline">base</Badge> : undefined}
    >
      <div className="border-l pl-2 sm:pl-4">
        <RuleGroups rules={wt.rules} />
        <SourceNotes sources={wt.sources} />
        <p className="px-2 pb-1 font-mono text-[11px] break-all text-muted-foreground">{wt.path}</p>
      </div>
    </Node>
  );
}

function RepoView({ repo }: { repo: PermissionRepoNode }) {
  return (
    <Node depth={1} counts={repo.counts} cache={repo.cache} title={`${repo.owner}/${repo.repo}`}>
      {repo.worktrees.length > 0 ? repo.worktrees.map((wt) => <WorktreeView key={wt.path} wt={wt} />) : null}
    </Node>
  );
}

function IdentityView({ identity }: { identity: PermissionIdentityNode }) {
  return (
    <Node
      depth={1}
      counts={identity.counts}
      cache={identity.cache}
      title={<span title={identity.configDir}>{identity.label || identity.name}</span>}
      badge={identity.retired ? <Badge variant="muted">retired</Badge> : undefined}
    >
      <div className="border-l pl-2 sm:pl-4">
        {identity.reason ? (
          <p className="px-2 py-1 text-xs text-muted-foreground">{identity.reason}</p>
        ) : (
          <>
            <RuleGroups rules={identity.rules} />
            <SourceNotes sources={identity.sources} />
          </>
        )}
      </div>
      {identity.repos.map((repo) => (
        <RepoView key={`${repo.owner}/${repo.repo}`} repo={repo} />
      ))}
    </Node>
  );
}

function ToolView({ tool }: { tool: PermissionToolNode }) {
  return (
    <Node
      depth={0}
      defaultOpen
      counts={tool.counts}
      cache={tool.cache}
      title={<ToolBadge tool={tool.toolName} />}
      badge={<span className="text-xs text-muted-foreground">{tool.identities.length} identities</span>}
    >
      {tool.identities.length > 0
        ? tool.identities.map((identity) => <IdentityView key={identity.name} identity={identity} />)
        : null}
    </Node>
  );
}

export function PermissionsPage() {
  const query = usePermissionsQuery();
  const client = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);

  const refresh = async () => {
    setRefreshing(true);
    try {
      client.setQueryData(qk.permissions, await api.getPermissions(true));
    } finally {
      setRefreshing(false);
    }
  };

  const data = query.data;
  return (
    <div className="min-w-0 space-y-4">
      <PageHeader
        title="Permissions"
        description="Read-only view of allow / ask / deny rules per identity, repository and worktree."
        updatedAt={query.dataUpdatedAt}
        actions={
          <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={refreshing}>
            <RefreshCw className={cn("size-4", refreshing && "animate-spin")} aria-hidden />
            Refresh
          </Button>
        }
      />
      {query.isError ? <ErrorBanner message={query.error.message} /> : null}
      {query.isLoading ? <Skeleton className="h-40 w-full" /> : null}
      {data ? (
        <Card>
          <CardContent className="min-w-0 space-y-3 pt-6">
            <div className="space-y-1.5 px-2">
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                <span>
                  Total <CountsBadge counts={data.counts} />
                </span>
                <span className="font-mono">
                  cache {data.cache.hits} hit / {data.cache.misses} miss
                  {data.refreshed ? " (refreshed)" : ""}
                </span>
              </div>
              <CountBar counts={data.counts} />
              <div className="flex gap-3 text-xs">
                {GROUPS.map((g) => (
                  <span key={g.key} className="inline-flex items-center gap-1">
                    <span className={cn("size-2 rounded-full", g.bar)} aria-hidden />
                    {g.label}
                  </span>
                ))}
              </div>
            </div>
            {data.tools.length === 0 ? (
              <EmptyState title="No tools" description="No identity registries were found." />
            ) : (
              data.tools.map((tool) => <ToolView key={tool.toolName} tool={tool} />)
            )}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
