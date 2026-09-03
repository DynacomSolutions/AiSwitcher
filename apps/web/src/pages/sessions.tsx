import { FolderSearch } from "lucide-react";
import { useState } from "react";

import { IdentityChip, ToolBadge } from "@/components/badges";
import { EmptyState, ErrorBanner, PageHeader } from "@/components/page-header";
import { RelativeTime } from "@/components/updated-ago";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useSessionsQuery } from "@/hooks/queries";
import { useDebouncedValue } from "@/hooks/use-ticker";
import { shortId } from "@/lib/format";
import type { ToolResumeResult } from "@/types/api";

function SessionGroup({ result }: { result: ToolResumeResult }) {
  const sessions = [...result.sessions].sort(
    (a, b) => Date.parse(b.lastActiveAt) - Date.parse(a.lastActiveAt),
  );

  return (
    <Card className="gap-3 py-4">
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <ToolBadge tool={result.toolName} />
          <IdentityChip name={result.identity.name} />
          <Badge variant="secondary" className="ml-auto tabular-nums">
            {sessions.length} session{sessions.length === 1 ? "" : "s"}
          </Badge>
        </div>
        {result.error ? (
          <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
            Read error: {result.error}
          </p>
        ) : null}
      </CardHeader>
      <CardContent>
        <ul className="divide-y">
          {sessions.map((session) => (
            <li key={session.sessionId} className="flex items-center justify-between gap-4 py-2">
              <div className="min-w-0">
                <p className="truncate text-sm">{session.label || "Untitled session"}</p>
                <p className="font-mono text-xs text-muted-foreground" title={session.sessionId}>
                  {shortId(session.sessionId)}
                </p>
              </div>
              <RelativeTime
                iso={session.lastActiveAt}
                className="shrink-0 text-xs text-muted-foreground"
              />
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

export function SessionsPage() {
  const [cwdInput, setCwdInput] = useState("");
  const cwd = useDebouncedValue(cwdInput.trim(), 400);
  const query = useSessionsQuery(cwd);
  const results = query.data?.results ?? [];
  const withErrors = results.filter((r) => r.error !== undefined).length;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Sessions"
        description="Resumable sessions recorded for a working directory, grouped by tool and identity."
        updatedAt={query.dataUpdatedAt}
      />

      <form
        onSubmit={(e) => e.preventDefault()}
        className="relative max-w-xl"
        role="search"
      >
        <FolderSearch
          aria-hidden
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          className="pl-9"
          placeholder="Working directory (blank uses the server default)"
          value={cwdInput}
          onChange={(e) => setCwdInput(e.target.value)}
          spellCheck={false}
        />
      </form>

      {query.isLoading && !query.data ? (
        <div className="grid gap-4 lg:grid-cols-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-44 animate-pulse rounded-xl bg-muted" />
          ))}
        </div>
      ) : query.isError && !query.data ? (
        <ErrorBanner message={query.error.message} />
      ) : results.length === 0 ? (
        <EmptyState
          title="No resumable sessions found"
          description={
            cwd.length > 0
              ? "Nothing has been recorded for this directory; try clearing the filter."
              : "Launch an agent in a project directory and its sessions will appear here."
          }
        />
      ) : (
        <>
          {withErrors > 0 ? (
            <p className="text-xs text-muted-foreground">
              {withErrors} group{withErrors === 1 ? "" : "s"} reported read errors; details inline below.
            </p>
          ) : null}
          <div className="grid gap-4 lg:grid-cols-2">
            {results.map((r, index) => (
              <SessionGroup key={`${r.toolName}/${r.identity.name}/${index}`} result={r} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export default SessionsPage;
