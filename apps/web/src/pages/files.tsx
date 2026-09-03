import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ChevronRight,
  DatabaseBackup,
  FileText,
  FileWarning,
  Folder,
  FolderOpen,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { ErrorBanner, PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import {
  qk,
  useFileContentQuery,
  useFileRootsQuery,
  useFileTreeQuery,
} from "@/hooks/queries";
import { api } from "@/lib/api";
import { formatBytes, joinPath, relTime } from "@/lib/format";
import type { FileRoot } from "@/types/api";

function baseOf(root: FileRoot): string {
  return root.path ?? root.root;
}

function basename(path: string): string {
  const withoutTrailing = path.endsWith("/") ? path.slice(0, -1) : path;
  const index = withoutTrailing.lastIndexOf("/");
  return index >= 0 ? withoutTrailing.slice(index + 1) : withoutTrailing;
}

interface BreadcrumbProps {
  rootLabel: string;
  basePath: string;
  currentPath: string;
  onNavigate: (path: string) => void;
}

function Breadcrumb({ rootLabel, basePath, currentPath, onNavigate }: BreadcrumbProps) {
  const relative = currentPath.startsWith(basePath)
    ? currentPath.slice(basePath.length).replace(/^\//, "")
    : "";
  const segments = relative.length > 0 ? relative.split("/") : [];

  return (
    <nav aria-label="Directory path" className="flex min-w-0 flex-wrap items-center gap-1 text-sm">
      <button
        type="button"
        className="rounded px-1 py-0.5 font-medium hover:bg-accent hover:text-accent-foreground"
        onClick={() => onNavigate(basePath)}
      >
        {rootLabel}
      </button>
      {segments.map((segment, i) => {
        const isLast = i === segments.length - 1;
        const target = joinPath(basePath, segments.slice(0, i + 1).join("/"));
        return (
          <span key={target} className="flex min-w-0 items-center gap-1">
            <ChevronRight aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
            {isLast ? (
              <span className="truncate rounded px-1 py-0.5 font-medium" aria-current="page">
                {segment}
              </span>
            ) : (
              <button
                type="button"
                className="truncate rounded px-1 py-0.5 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                onClick={() => onNavigate(target)}
              >
                {segment}
              </button>
            )}
          </span>
        );
      })}
    </nav>
  );
}

function DirectoryListing({
  rootKey,
  currentPath,
  entries,
  isLoading,
  error,
  onNavigate,
  onOpenFile,
}: {
  rootKey: string;
  currentPath: string;
  entries: Array<{ name: string; kind: "file" | "directory"; size?: number; mtime?: string }> | undefined;
  isLoading: boolean;
  error: string | null;
  onNavigate: (path: string) => void;
  onOpenFile: (path: string) => void;
}) {
  const sorted = useMemo(() => {
    if (!entries) return [];
    return [...entries].sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }, [entries]);

  if (error) {
    return (
      <div className="space-y-3">
        <ErrorBanner message={error} />
        <p className="text-xs text-muted-foreground">Use the path bar above to navigate back.</p>
      </div>
    );
  }

  if (isLoading && !entries) {
    return (
      <div className="space-y-2 pt-1">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="h-7 animate-pulse rounded-md bg-muted" style={{ width: `${95 - i * 4}%` }} />
        ))}
      </div>
    );
  }

  if (sorted.length === 0) {
    return (
      <p className="px-2 py-10 text-center text-sm text-muted-foreground">
        This directory is empty.
      </p>
    );
  }

  return (
    <ul className="space-y-0.5">
      {sorted.map((entry) => {
        const fullPath = joinPath(currentPath, entry.name);
        return (
          <li key={`${rootKey}/${entry.name}`}>
            <button
              type="button"
              className="grid w-full grid-cols-[auto_1fr_auto_auto] items-center gap-3 rounded-md px-2.5 py-1.5 text-left text-sm hover:bg-accent/70"
              onClick={() =>
                entry.kind === "directory" ? onNavigate(fullPath) : onOpenFile(fullPath)
              }
            >
              {entry.kind === "directory" ? (
                <Folder aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              ) : (
                <FileText aria-hidden className="size-4 shrink-0 text-muted-foreground/80" />
              )}
              <span className="truncate">{entry.name}</span>
              <span className="text-right text-xs tabular-nums text-muted-foreground">
                {entry.kind === "file" ? formatBytes(entry.size) : ""}
              </span>
              <span className="w-20 text-right text-xs text-muted-foreground">
                {entry.mtime ? relTime(entry.mtime) : ""}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function EditorPane({ filePath }: { filePath: string | null }) {
  const qc = useQueryClient();
  const query = useFileContentQuery(filePath);
  const data = query.data;

  const [draft, setDraft] = useState("");
  const [savedContent, setSavedContent] = useState("");

  // Sync local draft whenever a different file finishes loading (or the same
  // file refetches after a save): this mirrors external state into the form.
  useEffect(() => {
    if (data && !data.binary) {
      setDraft(data.content);
      setSavedContent(data.content);
    }
  }, [data]);

  const dirty = data !== undefined && !data.binary && draft !== savedContent;

  const saveMutation = useMutation({
    mutationFn: () => api.saveFile(filePath as string, draft),
    onSuccess: () => {
      setSavedContent(draft);
      toast.warning("File saved", {
        description: "The previous version was backed up by the console server.",
      });
      void qc.invalidateQueries({ queryKey: qk.fileContent(filePath ?? "") });
    },
    onError: (error) => toast.error("Save failed", { description: error.message }),
  });

  if (!filePath) {
    return (
      <Card className="gap-3">
        <CardHeader>
          <CardTitle className="text-base">Editor</CardTitle>
          <CardDescription>Select a text file to view or edit it.</CardDescription>
        </CardHeader>
        <CardContent className="flex h-[480px] items-center justify-center rounded-lg border border-dashed">
          <p className="max-w-64 text-center text-sm text-muted-foreground">
            Nothing open. Files stay inside whitelisted roots only.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="gap-3">
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <CardTitle className="truncate font-mono text-sm" title={filePath}>
              {basename(filePath)}
            </CardTitle>
            {dirty ? <Badge variant="warning">Unsaved changes</Badge> : null}
          </div>
          <Button
            size="sm"
            disabled={!dirty || saveMutation.isPending}
            onClick={() => saveMutation.mutate()}
          >
            Save
          </Button>
        </div>
        {data && !data.binary ? (
          <CardDescription>
            {formatBytes(data.size)}
            {data.mtime ? `, modified ${relTime(data.mtime)}` : ""}
          </CardDescription>
        ) : null}
      </CardHeader>
      <CardContent>
        {query.isLoading && !data ? (
          <div className="h-[480px] animate-pulse rounded-lg bg-muted" />
        ) : query.isError && !data ? (
          <ErrorBanner message={query.error.message} />
        ) : data?.binary ? (
          <div className="flex h-[480px] flex-col items-center justify-center gap-2 rounded-lg border border-dashed">
            <FileWarning aria-hidden className="size-6 text-muted-foreground/70" />
            <p className="text-sm font-medium">Binary file</p>
            <p className="text-xs text-muted-foreground">
              Previewing and editing is limited to text files up to 2 MB.
            </p>
          </div>
        ) : (
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            spellCheck={false}
            wrap="off"
            className="h-[480px] resize-none overflow-auto font-mono text-xs leading-relaxed"
          />
        )}
      </CardContent>
    </Card>
  );
}

export function FilesPage() {
  const rootsQuery = useFileRootsQuery();
  const roots = useMemo(() => rootsQuery.data?.roots ?? [], [rootsQuery.data]);
  const defaultRootKey =
    roots.find((r) => r.exists)?.root ?? roots[0]?.root ?? "";

  const [selectedRootKey, setSelectedRootKey] = useState<string | null>(null);
  const activeRootKey = selectedRootKey ?? defaultRootKey;
  const activeRoot = roots.find((r) => r.root === activeRootKey) ?? null;

  const [pathsByRoot, setPathsByRoot] = useState<Record<string, string>>({});
  const [openFilePath, setOpenFilePath] = useState<string | null>(null);

  const basePath = activeRoot ? baseOf(activeRoot) : "";
  const currentPath = (activeRootKey && pathsByRoot[activeRootKey]) || basePath;

  const treeQuery = useFileTreeQuery(activeRootKey, currentPath, activeRootKey !== "");

  function navigateTo(path: string) {
    if (!activeRootKey) return;
    setPathsByRoot((prev) => ({ ...prev, [activeRootKey]: path }));
    setOpenFilePath(null);
  }

  function switchRoot(key: string) {
    setSelectedRootKey(key);
    setOpenFilePath(null);
  }

  const backupMutation = useMutation({
    mutationFn: () => api.runBackup(),
    onSuccess: (result) => {
      toast.success("Config backup complete", { description: result.summary });
    },
    onError: (error) => toast.error("Backup failed", { description: error.message }),
  });

  const treeError = treeQuery.isError && !treeQuery.data
    ? (treeQuery.error instanceof Error ? treeQuery.error.message : "Could not list this directory.")
    : null;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Files"
        description="Whitelisted configuration roots only: traversal outside them is rejected server-side."
        updatedAt={undefined}
        actions={
          <Button
            variant="outline"
            size="sm"
            disabled={backupMutation.isPending}
            onClick={() => backupMutation.mutate()}
          >
            <DatabaseBackup aria-hidden />
            Back up configs now
          </Button>
        }
      />

      <div className="flex max-w-xl items-end gap-3">
        <div className="w-full space-y-2">
          <Label htmlFor="files-root">Root</Label>
          <Select value={activeRootKey || undefined} onValueChange={switchRoot}>
            <SelectTrigger id="files-root" className="w-full">
              <SelectValue placeholder="Choose a root directory" />
            </SelectTrigger>
            <SelectContent>
              {roots.map((root) => (
                <SelectItem key={root.root} value={root.root} disabled={!root.exists}>
                  {root.label}
                  {!root.exists ? " (missing)" : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="grid items-start gap-4 lg:grid-cols-2">
        <Card className="gap-3">
          <CardHeader className="gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Breadcrumb
                rootLabel={activeRoot?.label ?? "Root"}
                basePath={basePath}
                currentPath={currentPath}
                onNavigate={navigateTo}
              />
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Refresh listing"
                onClick={() => void treeQuery.refetch()}
              >
                <FolderOpen aria-hidden />
              </Button>
            </div>
            <Separator />
          </CardHeader>
          <CardContent>
            <ScrollArea className="h-[520px] pr-3">
              {!activeRootKey ? (
                <p className="px-2 py-10 text-center text-sm text-muted-foreground">
                  No file roots available.
                </p>
              ) : (
                <DirectoryListing
                  rootKey={activeRootKey}
                  currentPath={currentPath}
                  entries={treeQuery.data?.entries}
                  isLoading={treeQuery.isLoading}
                  error={treeError}
                  onNavigate={navigateTo}
                  onOpenFile={setOpenFilePath}
                />
              )}
            </ScrollArea>
          </CardContent>
        </Card>

        <EditorPane filePath={openFilePath} />
      </div>
    </div>
  );
}

export default FilesPage;
