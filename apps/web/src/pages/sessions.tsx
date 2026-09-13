import { Bot, ChevronDown, ChevronRight, Circle, ListCollapse, ListTree } from "lucide-react";
import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";

import { IdentityChip, ToolBadge } from "@/components/badges";
import { EmptyState, ErrorBanner, PageHeader } from "@/components/page-header";
import { SessionChat, type ChatTarget } from "@/components/session-chat";
import { RelativeTime } from "@/components/updated-ago";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useIdentitiesQuery, useSessionTreeQuery } from "@/hooks/queries";
import { autoIdentityColour } from "@/lib/colour";
import { shortId } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { SessionTreeNode, ToolSessionTree } from "@/types/api";

const DAY_OPTIONS = [1, 7, 30, 90] as const;
const DEFAULT_DAYS = 30;

/** One rendered row of the tree: a node plus its attached children. */
interface TreeRow {
  node: SessionTreeNode;
  children: TreeRow[];
}

/** Links parents to children within one (tool, identity) slice. Orphans
 * (parentId set, parent missing, depth 0) intentionally render as roots,
 * matching the server contract. */
function buildTree(nodes: SessionTreeNode[]): TreeRow[] {
  const map = new Map<string, TreeRow>();
  for (const node of nodes) map.set(node.id, { node, children: [] });
  const roots: TreeRow[] = [];
  for (const row of map.values()) {
    const parent = row.node.parentId !== undefined ? map.get(row.node.parentId) : undefined;
    if (row.node.depth > 0 && parent) parent.children.push(row);
    else roots.push(row);
  }
  const byStart = (a: TreeRow, b: TreeRow) => Date.parse(a.node.startedAt) - Date.parse(b.node.startedAt);
  const sortChildren = (rows: TreeRow[]) => {
    rows.sort(byStart);
    for (const row of rows) sortChildren(row.children);
  };
  roots.sort((a, b) => Date.parse(b.node.updatedAt) - Date.parse(a.node.updatedAt));
  sortChildren(roots);
  return roots;
}

function collectIdsWithChildren(rows: TreeRow[]): string[] {
  const ids: string[] = [];
  for (const row of rows) {
    if (row.children.length > 0) ids.push(row.node.id);
    ids.push(...collectIdsWithChildren(row.children));
  }
  return ids;
}

/** Pulsing live marker for in-progress sessions. */
function LiveDot({ className }: { className?: string }) {
  return (
    <span
      aria-label="In progress"
      title="In progress (file active in the last minute)"
      className={cn("relative inline-flex size-2 shrink-0", className)}
    >
      <Circle aria-hidden className="absolute inset-0 size-2 animate-ping text-emerald-500/70" />
      <Circle aria-hidden className="size-2 fill-emerald-500 text-emerald-500" />
    </span>
  );
}

function TreeNodeRows({
  rows,
  colour,
  collapsed,
  onToggle,
  onOpen,
}: {
  rows: TreeRow[];
  colour: string;
  collapsed: Set<string>;
  onToggle: (id: string) => void;
  onOpen: (node: SessionTreeNode) => void;
}) {
  return (
    <>
      {rows.map((row) => {
        const { node } = row;
        const hasChildren = row.children.length > 0;
        const isCollapsed = collapsed.has(node.id);
        return (
          <div key={node.id}>
            <div
              role="button"
              tabIndex={0}
              aria-label={`Open chat: ${node.title}`}
              onClick={() => onOpen(node)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onOpen(node);
                }
              }}
              className="group flex cursor-pointer items-center gap-1.5 rounded-md py-1 pr-2 hover:bg-accent/50 focus-visible:outline-2 focus-visible:outline-ring"
            >
              {hasChildren ? (
                <button
                  type="button"
                  aria-label={isCollapsed ? `Expand ${node.title}` : `Collapse ${node.title}`}
                  aria-expanded={!isCollapsed}
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggle(node.id);
                  }}
                  className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  {isCollapsed ? (
                    <ChevronRight aria-hidden className="size-3.5" />
                  ) : (
                    <ChevronDown aria-hidden className="size-3.5" />
                  )}
                </button>
              ) : (
                <span aria-hidden className="flex size-5 shrink-0 items-center justify-center">
                  <span className="size-1 rounded-full bg-border" />
                </span>
              )}

              {node.inProgress ? <LiveDot /> : null}

              <span className={cn("min-w-0 flex-1 truncate text-sm", node.depth > 0 && "text-[13px] text-foreground/90")}>
                {node.title}
              </span>

              {node.depth > 0 && node.agentName ? (
                <Badge variant="muted" className="gap-1 px-1.5 font-mono text-[10px]" title={`Spawned agent: ${node.agentName}`}>
                  <Bot aria-hidden className="size-3" />
                  {node.agentName}
                </Badge>
              ) : null}
              {hasChildren && isCollapsed ? (
                <Badge variant="secondary" className="px-1.5 text-[10px] tabular-nums" title="Collapsed sub-sessions">
                  +{row.children.length}
                </Badge>
              ) : null}

              <span className="hidden shrink-0 items-center gap-2 text-[11px] text-muted-foreground tabular-nums sm:flex">
                {node.messageCount !== undefined ? <span>{node.messageCount.toLocaleString()} msgs</span> : null}
                <span className="hidden md:inline" title={`Started ${node.startedAt}`}>
                  <span className="hidden font-mono lg:inline">{shortId(node.id)} · </span>
                  started <RelativeInline iso={node.startedAt} />
                </span>
                <span title={`Last activity ${node.updatedAt}`}>
                  active <RelativeInline iso={node.updatedAt} />
                </span>
              </span>
              <span
                aria-hidden
                className="ml-0.5 h-4 w-0.5 shrink-0 rounded-full opacity-0 transition-opacity group-hover:opacity-100"
                style={{ backgroundColor: colour }}
              />
            </div>

            {hasChildren && !isCollapsed ? (
              <div className="ml-2.5 border-l pl-2" style={{ borderColor: `${colour}33` }}>
                <TreeNodeRows
                  rows={row.children}
                  colour={colour}
                  collapsed={collapsed}
                  onToggle={onToggle}
                  onOpen={onOpen}
                />
              </div>
            ) : null}
          </div>
        );
      })}
    </>
  );
}

/** Self-freshing relative timestamp (thin wrapper over RelativeTime). */
function RelativeInline({ iso }: { iso: string }) {
  return <RelativeTime iso={iso} className="whitespace-nowrap" />;
}

/** Defaults for per-section collapse: big slices start with their roots
 * folded so the page stays navigable; small trees render fully open. */
function initialCollapsed(slice: ToolSessionTree, roots: TreeRow[]): Set<string> {
  if (slice.nodes.length <= 60) return new Set();
  return new Set(roots.filter((r) => r.children.length > 0).map((r) => r.node.id));
}

function TreeSection({
  slice,
  colour,
  onOpen,
}: {
  slice: ToolSessionTree;
  colour: string;
  onOpen: (node: SessionTreeNode) => void;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    const roots = buildTree(slice.nodes);
    return initialCollapsed(slice, roots);
  });

  const tree = useMemo(() => buildTree(slice.nodes), [slice.nodes]);
  const inProgress = slice.nodes.filter((n) => n.inProgress).length;
  const children = slice.nodes.filter((n) => n.depth > 0).length;
  const withChildrenIds = useMemo(() => collectIdsWithChildren(tree), [tree]);

  const toggle = (id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const setAll = (fold: boolean) => {
    setCollapsed(fold ? new Set(withChildrenIds) : new Set());
  };

  return (
    <Card className="gap-3 py-4" style={{ borderLeft: `3px solid ${colour}` }}>
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <ToolBadge tool={slice.tool} />
          <IdentityChip name={slice.identity} colour={colour} />
          <Badge variant="secondary" className="tabular-nums">
            {slice.nodes.length - children} session{slice.nodes.length - children === 1 ? "" : "s"}
            {children > 0 ? `, ${children} agent${children === 1 ? "" : "s"}` : ""}
          </Badge>
          {inProgress > 0 ? (
            <Badge variant="success" className="gap-1 tabular-nums">
              <LiveDot />
              {inProgress} live
            </Badge>
          ) : null}
          {slice.unavailable ? (
            <Badge variant="muted">Tree unavailable</Badge>
          ) : null}
          <div className="ml-auto flex items-center gap-1">
            <Button variant="ghost" size="icon-sm" aria-label="Expand all" onClick={() => setAll(false)}>
              <ListTree aria-hidden />
            </Button>
            <Button variant="ghost" size="icon-sm" aria-label="Collapse all" onClick={() => setAll(true)}>
              <ListCollapse aria-hidden />
            </Button>
          </div>
        </div>
        {slice.error ? (
          <p className="text-xs text-muted-foreground">Read error: {slice.error}</p>
        ) : null}
      </CardHeader>
      <CardContent>
        {slice.unavailable ? (
          <p className="rounded-lg border border-dashed px-3 py-4 text-center text-xs text-muted-foreground">
            {slice.unavailable}
          </p>
        ) : tree.length === 0 ? (
          <p className="rounded-lg border border-dashed px-3 py-4 text-center text-xs text-muted-foreground">
            No sessions in this window.
          </p>
        ) : (
          <TreeNodeRows
            rows={tree}
            colour={colour}
            collapsed={collapsed}
            onToggle={toggle}
            onOpen={onOpen}
          />
        )}
      </CardContent>
    </Card>
  );
}

/** Deep link decoding for the open chat: "tool:identity:id" (ids are opaque
 * but contain no colons in practice; the id keeps any extras on split). */
function parseChat(raw: string | null): ChatTarget | null {
  if (!raw) return null;
  const [tool = "", identity = "", ...rest] = raw.split(":");
  const id = rest.join(":");
  if (!tool || !identity || !id) return null;
  return { tool, identity, id };
}

export function SessionsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const treeQuery = useSessionTreeQuery(
    searchParams.get("tool") ?? "",
    searchParams.get("identity") ?? "",
    parsedDays(searchParams.get("days")),
  );
  const identitiesQuery = useIdentitiesQuery();

  const tool = searchParams.get("tool") ?? "";
  const identity = searchParams.get("identity") ?? "";
  const days = parsedDays(searchParams.get("days"));
  const chat = parseChat(searchParams.get("chat"));

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(searchParams);
    if (value.length > 0) next.set(key, value);
    else next.delete(key);
    setSearchParams(next);
  };

  const slices = treeQuery.data?.tools ?? [];
  const visible = useMemo(
    () =>
      [...slices].sort((a, b) => {
        const aLive = a.nodes.some((n) => n.inProgress) ? 1 : 0;
        const bLive = b.nodes.some((n) => n.inProgress) ? 1 : 0;
        if (aLive !== bLive) return bLive - aLive;
        const aLast = a.nodes.reduce((max, n) => Math.max(max, Date.parse(n.updatedAt)), 0);
        const bLast = b.nodes.reduce((max, n) => Math.max(max, Date.parse(n.updatedAt)), 0);
        return bLast - aLast;
      }),
    [slices],
  );

  const effectiveColours = identitiesQuery.data?.registries ?? [];
  const colourFor = (t: string, name: string): string => {
    for (const registry of effectiveColours) {
      if (registry.toolName !== t) continue;
      const hit = registry.identities.find((i) => i.name === name);
      if (hit?.effectiveColour) return hit.effectiveColour;
    }
    return autoIdentityColour(t, name);
  };

  const toolOptions = useMemo(() => {
    const names = new Set<string>();
    for (const registry of effectiveColours) names.add(registry.toolName);
    for (const slice of slices) names.add(slice.tool);
    return [...names].sort();
  }, [effectiveColours, slices]);

  const identityOptions = useMemo(() => {
    const names = new Set<string>();
    for (const registry of effectiveColours) {
      if (tool && registry.toolName !== tool) continue;
      for (const item of registry.identities) names.add(item.name);
    }
    for (const slice of slices) {
      if (tool && slice.tool !== tool) continue;
      names.add(slice.identity);
    }
    return [...names].sort();
  }, [effectiveColours, slices, tool]);

  const totalSessions = slices.reduce((sum, s) => sum + s.nodes.filter((n) => n.depth === 0).length, 0);
  const totalLive = slices.reduce((sum, s) => sum + s.nodes.filter((n) => n.inProgress).length, 0);

  const openChat = (node: SessionTreeNode) => setParam("chat", `${node.tool}:${node.identity}:${node.id}`);
  const closeChat = () => setParam("chat", "");

  return (
    <div className="space-y-5">
      <PageHeader
        title="Sessions"
        description="Session trees: what spawned which agent, per tool and identity. Click a session to read its chat."
        updatedAt={treeQuery.dataUpdatedAt}
      />

      <div className="flex flex-wrap items-center gap-2">
        <Select value={tool} onValueChange={(v) => setParam("tool", v === "all" ? "" : v)}>
          <SelectTrigger className="h-8 w-40 text-xs" aria-label="Tool">
            <SelectValue placeholder="All tools" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all" className="text-xs">
              All tools
            </SelectItem>
            {toolOptions.map((name) => (
              <SelectItem key={name} value={name} className="text-xs">
                {name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={identity} onValueChange={(v) => setParam("identity", v === "all" ? "" : v)}>
          <SelectTrigger className="h-8 w-44 text-xs" aria-label="Identity">
            <SelectValue placeholder="All identities" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all" className="text-xs">
              All identities
            </SelectItem>
            {identityOptions.map((name) => (
              <SelectItem key={name} value={name} className="text-xs">
                {name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={String(days)} onValueChange={(v) => setParam("days", v)}>
          <SelectTrigger className="h-8 w-36 text-xs" aria-label="Lookback window">
            <SelectValue placeholder="Window" />
          </SelectTrigger>
          <SelectContent>
            {DAY_OPTIONS.map((option) => (
              <SelectItem key={option} value={String(option)} className="text-xs">
                Last {option} day{option === 1 ? "" : "s"}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {treeQuery.data ? (
          <span className="ml-auto text-xs text-muted-foreground tabular-nums">
            {totalSessions} session{totalSessions === 1 ? "" : "s"}
            {totalLive > 0 ? `, ${totalLive} live` : ""} · {visible.length} identit{visible.length === 1 ? "y" : "ies"}
          </span>
        ) : null}
      </div>

      {treeQuery.isLoading && !treeQuery.data ? (
        <div className="space-y-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-48 animate-pulse rounded-xl bg-muted" />
          ))}
        </div>
      ) : treeQuery.isError && !treeQuery.data ? (
        <ErrorBanner message={treeQuery.error.message} />
      ) : visible.length === 0 ? (
        <EmptyState
          title="No session activity found"
          description={`No agent sessions recorded in the last ${days} day${days === 1 ? "" : "s"} for this filter; launch an agent or widen the window.`}
        />
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          {visible.map((slice) => (
            <TreeSection
              key={`${slice.tool}/${slice.identity}`}
              slice={slice}
              colour={colourFor(slice.tool, slice.identity)}
              onOpen={openChat}
            />
          ))}
        </div>
      )}

      {chat ? (
        <SessionChat
          target={chat}
          colour={colourFor(chat.tool, chat.identity)}
          onClose={closeChat}
        />
      ) : null}
    </div>
  );
}

function parsedDays(raw: string | null): number {
  const n = Number.parseInt(raw ?? "", 10);
  return (DAY_OPTIONS as readonly number[]).includes(n) ? n : DEFAULT_DAYS;
}

export default SessionsPage;
