import { useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ChevronsUp, Loader2, Radio, Wrench, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { IdentityChip, ToolBadge } from "@/components/badges";
import { ErrorBanner } from "@/components/page-header";
import { RelativeTime } from "@/components/updated-ago";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useSessionTranscriptQuery } from "@/hooks/queries";
import { ApiError } from "@/lib/api";
import { formatTokens } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { TranscriptTurn } from "@/types/api";

/** Server hard cap (docs/API.md). */
const MAX_TAIL = 2000;
const DEFAULT_TAIL = 500;

export interface ChatTarget {
  tool: string;
  identity: string;
  id: string;
  title?: string;
}

/** True when the transcript turn carries no renderable text. */
function isEmptyText(turn: TranscriptTurn): boolean {
  return turn.text.length === 0;
}

function TurnTime({ atMs }: { atMs?: number }) {
  if (atMs === undefined) return null;
  const time = new Date(atMs).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
  return <span className="tabular-nums">{time}</span>;
}

function ExpandableText({
  text,
  clampLines,
  className,
}: {
  text: string;
  clampLines: number;
  className?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const long = text.length > 360;
  return (
    <>
      <p
        className={cn(
          "whitespace-pre-wrap break-words",
          !expanded && long && "pointer-events-none",
          className,
        )}
        style={!expanded && long ? { display: "-webkit-box", WebkitLineClamp: clampLines, WebkitBoxOrient: "vertical", overflow: "hidden" } : undefined}
      >
        {text}
      </p>
      {long ? (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="text-[11px] text-muted-foreground underline-offset-2 hover:underline"
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      ) : null}
    </>
  );
}

function ToolCard({ turn }: { turn: TranscriptTurn }) {
  const running = isEmptyText(turn);
  const [showArgs, setShowArgs] = useState(false);
  const longArgs = (turn.argsPreview?.length ?? 0) > 160;
  return (
    <div className="mr-auto w-[92%] rounded-lg border bg-card/60 py-1.5">
      <div className="flex items-center gap-1.5 px-2.5 pb-1">
        <Wrench aria-hidden className="size-3 text-muted-foreground" />
        <span className="font-mono text-[11px] font-medium">{turn.toolName ?? "tool"}</span>
        {running ? <Loader2 aria-hidden className="size-3 animate-spin text-muted-foreground" /> : null}
        <span className="ml-auto flex items-center gap-2 text-[10px] text-muted-foreground">
          {turn.tokens !== undefined ? <span className="tabular-nums">{formatTokens(turn.tokens)} tok</span> : null}
          <TurnTime atMs={turn.atMs} />
        </span>
      </div>
      {turn.argsPreview ? (
        <div className="px-2.5">
          <pre
            className={cn(
              "overflow-hidden font-mono text-[11px] leading-relaxed break-all whitespace-pre-wrap text-muted-foreground",
              !showArgs && longArgs && "max-h-10 [mask-image:linear-gradient(to_bottom,black_60%,transparent)]",
            )}
          >
            {turn.argsPreview}
          </pre>
          {longArgs ? (
            <button
              type="button"
              onClick={() => setShowArgs((v) => !v)}
              className="text-[10px] text-muted-foreground underline-offset-2 hover:underline"
            >
              {showArgs ? "Hide input" : "Full input"}
            </button>
          ) : null}
        </div>
      ) : null}
      {running ? null : (
        <div className="px-2.5 pt-1">
          <ExpandableText text={turn.text} clampLines={6} className="font-mono text-[11px] leading-relaxed" />
        </div>
      )}
    </div>
  );
}

function Turn({ turn }: { turn: TranscriptTurn }) {
  if (turn.role === "user") {
    return (
      <div className="flex flex-col items-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-primary px-3.5 py-2 text-sm text-primary-foreground">
          <ExpandableText text={turn.text} clampLines={10} />
        </div>
        <div className="mt-0.5 flex items-center gap-2 px-1 text-[10px] text-muted-foreground">
          {turn.tokens !== undefined ? <span className="tabular-nums">{formatTokens(turn.tokens)} tok</span> : null}
          <TurnTime atMs={turn.atMs} />
        </div>
      </div>
    );
  }
  if (turn.role === "assistant") {
    return (
      <div className="flex flex-col items-start">
        <div className="max-w-[85%] rounded-2xl rounded-bl-sm bg-muted px-3.5 py-2 text-sm">
          <ExpandableText text={turn.text} clampLines={12} />
        </div>
        <div className="mt-0.5 flex items-center gap-2 px-1 text-[10px] text-muted-foreground">
          {turn.tokens !== undefined ? <span className="tabular-nums">{formatTokens(turn.tokens)} tok</span> : null}
          <TurnTime atMs={turn.atMs} />
        </div>
      </div>
    );
  }
  if (turn.role === "tool") {
    return <ToolCard turn={turn} />;
  }
  // system: rare; dimmed inline line.
  return (
    <p className="border-l-2 border-dashed border-border px-2 text-xs text-muted-foreground">
      {turn.text}
      {turn.atMs !== undefined ? (
        <span className="ml-2 tabular-nums opacity-70">
          <TurnTime atMs={turn.atMs} />
        </span>
      ) : null}
    </p>
  );
}

/**
 * Slide-in chat view for one session's normalized transcript. Live: polls
 * every 3s while the session is in progress (server cache 4s), auto-follows
 * the tail when the reader is at the bottom, and offers a jump pill
 * otherwise. `tail` doubles on "Load earlier" up to the server hard cap.
 */
export function SessionChat({
  target,
  colour,
  onClose,
}: {
  target: ChatTarget;
  /** Effective identity colour for the header chip. */
  colour?: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [tail, setTail] = useState(DEFAULT_TAIL);
  const query = useSessionTranscriptQuery(target.tool, target.identity, target.id, tail, true);
  const transcript = query.data?.transcript;

  // Reset the tail when a different session opens.
  useEffect(() => {
    setTail(DEFAULT_TAIL);
  }, [target.id]);

  // Escape closes, like the dialogs.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const [newCount, setNewCount] = useState(0);
  const lastCountRef = useRef(0);
  const lastIdRef = useRef(target.id);
  // scrollHeight captured before a Load-earlier refetch, to restore position.
  const anchorRef = useRef<number | null>(null);

  const scrollToBottom = useCallback((smooth = false) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  }, []);

  const turnCount = transcript?.turns.length ?? 0;

  useEffect(() => {
    const el = scrollRef.current;
    const switched = lastIdRef.current !== target.id;
    if (switched) {
      lastIdRef.current = target.id;
      stickRef.current = true;
      setNewCount(0);
      anchorRef.current = null;
      if (el) requestAnimationFrame(() => scrollToBottom());
      lastCountRef.current = transcript?.turns.length ?? 0;
      return;
    }
    if (anchorRef.current !== null && el) {
      // Load-earlier completed: keep the previously-first turn in view.
      el.scrollTop += el.scrollHeight - anchorRef.current;
      anchorRef.current = null;
      lastCountRef.current = turnCount;
      return;
    }
    if (turnCount > lastCountRef.current) {
      if (stickRef.current) scrollToBottom(true);
      else setNewCount((c) => c + (turnCount - lastCountRef.current));
    }
    lastCountRef.current = turnCount;
  }, [turnCount, transcript, target.id, scrollToBottom]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    stickRef.current = atBottom;
    if (atBottom) setNewCount(0);
  };

  const loadEarlier = () => {
    const el = scrollRef.current;
    if (el) anchorRef.current = el.scrollHeight;
    setTail((t) => Math.min(MAX_TAIL, t * 2));
  };

  const error404 = query.error instanceof ApiError && query.error.status === 404;

  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label="Session chat">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-[2px]" onClick={onClose} />
      <div className="absolute inset-y-0 right-0 flex w-full flex-col border-l bg-background shadow-xl outline-none sm:max-w-xl lg:max-w-2xl animate-in slide-in-from-right duration-200">
        {/* Header */}
        <div className="space-y-2 border-b px-4 py-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 space-y-1.5">
              <h2 className="truncate text-sm font-semibold leading-snug">
                {transcript?.session.title ?? target.title ?? "Session"}
              </h2>
              <div className="flex flex-wrap items-center gap-1.5">
                <ToolBadge tool={target.tool} />
                <IdentityChip name={target.identity} colour={colour} />
                {transcript?.inProgress ? (
                  <Badge variant="success" className="gap-1">
                    <Radio aria-hidden className="size-3 animate-pulse" />
                    Live
                  </Badge>
                ) : null}
              </div>
            </div>
            <Button variant="ghost" size="icon-sm" aria-label="Close chat" onClick={onClose}>
              <X aria-hidden />
            </Button>
          </div>
          {transcript?.session.cwd ? (
            <p className="truncate font-mono text-[11px] text-muted-foreground" title={transcript.session.cwd}>
              {transcript.session.cwd}
            </p>
          ) : null}
        </div>

        {/* Transcript */}
        <div className="relative flex-1 overflow-hidden">
          <div
            ref={scrollRef}
            onScroll={onScroll}
            className="h-full space-y-3 overflow-y-auto px-4 py-4"
          >
            {query.isLoading && !query.data ? (
              <div className="space-y-3">
                {Array.from({ length: 6 }).map((_, i) => (
                  <div
                    key={i}
                    className={cn("h-12 animate-pulse rounded-2xl bg-muted", i % 2 === 0 ? "mr-auto w-4/5" : "ml-auto w-3/5")}
                  />
                ))}
              </div>
            ) : query.isError && !query.data ? (
              <ErrorBanner
                message={error404 ? "This session no longer exists (its store may have rotated away)." : query.error.message}
              />
            ) : transcript ? (
              <>
                {transcript.truncated ? (
                  <div className="flex flex-col items-center gap-1 py-1">
                    <p className="text-xs text-muted-foreground">
                      Showing last {transcript.turns.length} of {transcript.totalTurns.toLocaleString()} turns
                    </p>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 text-xs"
                      disabled={tail >= MAX_TAIL || query.isFetching}
                      onClick={loadEarlier}
                    >
                      <ChevronsUp aria-hidden />
                      {tail >= MAX_TAIL ? "Full history loaded" : "Load earlier"}
                    </Button>
                  </div>
                ) : null}
                {transcript.turns.map((turn, i) => (
                  <Turn key={i} turn={turn} />
                ))}
                {transcript.inProgress ? (
                  <p className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Loader2 aria-hidden className="size-3 animate-spin" />
                    Session is active; new turns appear automatically.
                  </p>
                ) : null}
              </>
            ) : null}
          </div>

          {/* Jump pill */}
          {newCount > 0 ? (
            <button
              type="button"
              onClick={() => {
                stickRef.current = true;
                setNewCount(0);
                scrollToBottom(true);
              }}
              className="absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full border bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground shadow-lg"
            >
              <ArrowDown aria-hidden className="size-3.5" />
              {newCount} new turn{newCount === 1 ? "" : "s"}
            </button>
          ) : null}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-3 border-t px-4 py-2 text-xs text-muted-foreground">
          <span className="truncate font-mono" title={target.id}>
            {target.id.length > 24 ? `${target.id.slice(0, 24)}...` : target.id}
          </span>
          <span className="flex shrink-0 items-center gap-2">
            {transcript?.session.updatedAt ? (
              <RelativeTime iso={transcript.session.updatedAt} />
            ) : null}
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              onClick={() => void qc.refetchQueries({ queryKey: ["sessions", "transcript"] })}
              disabled={query.isFetching}
            >
              Refresh
            </Button>
          </span>
        </div>
      </div>
    </div>
  );
}
