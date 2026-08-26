import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Ellipsis, Plus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { PageHeader } from "@/components/page-header";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { useIdentitiesQuery, qk } from "@/hooks/queries";
import { api } from "@/lib/api";
import type { CreateIdentityBody, IdentityDto, RegistryDto, ToolName } from "@/types/api";

interface IdentityRef {
  tool: ToolName;
  identity: IdentityDto;
}

function useInvalidateIdentities() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: qk.identities });
  };
}

function EditIdentityDialog({
  tool,
  identity,
  onClose,
}: {
  tool: ToolName;
  identity: IdentityDto;
  onClose: () => void;
}) {
  const invalidate = useInvalidateIdentities();
  const [label, setLabel] = useState(identity.label);
  const [description, setDescription] = useState(identity.description ?? "");
  const [configDir, setConfigDir] = useState(identity.configDir);

  const mutation = useMutation({
    mutationFn: () =>
      api.patchIdentity(tool, identity.name, {
        label: label.trim(),
        description: description.trim() || undefined,
        configDir: configDir.trim(),
      }),
    onSuccess: () => {
      invalidate();
      toast.success("Identity updated", { description: `${tool}/${identity.name}` });
      onClose();
    },
    onError: (error) => toast.error("Update failed", { description: error.message }),
  });

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit identity</DialogTitle>
          <DialogDescription>
            {tool}/{identity.name}: registry metadata only; files inside the config directory are
            never touched.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="edit-label">Label</Label>
            <Input id="edit-label" value={label} onChange={(e) => setLabel(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="edit-description">Description</Label>
            <Textarea
              id="edit-description"
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional notes about this identity"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="edit-configdir">Config directory</Label>
            <Input
              id="edit-configdir"
              className="font-mono text-xs"
              value={configDir}
              onChange={(e) => setConfigDir(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => mutation.mutate()} disabled={mutation.isPending || !configDir.trim()}>
            Save changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PatternsDialog({
  tool,
  identity,
  kind,
  onClose,
}: {
  tool: ToolName;
  identity: IdentityDto;
  kind: "directories" | "aliases";
  onClose: () => void;
}) {
  const invalidate = useInvalidateIdentities();
  const isDirectories = kind === "directories";
  const current = isDirectories ? (identity.directories ?? []) : (identity.aliases ?? []);
  const singular = isDirectories ? "pattern" : "alias";
  const [draft, setDraft] = useState("");

  const addMutation = useMutation({
    mutationFn: (value: string) =>
      isDirectories
        ? api.addDirectoryPattern(tool, identity.name, value)
        : api.addAlias(tool, identity.name, value),
    onSuccess: (_data, value) => {
      invalidate();
      toast.success(`Added ${singular}`, { description: value });
      setDraft("");
    },
    onError: (error) => toast.error(`Could not add ${singular}`, { description: error.message }),
  });

  const removeMutation = useMutation({
    mutationFn: (value: string) =>
      isDirectories
        ? api.removeDirectoryPattern(tool, identity.name, value)
        : api.removeAlias(tool, identity.name, value),
    onSuccess: (_data, value) => {
      invalidate();
      toast.success(`Removed ${singular}`, { description: value });
    },
    onError: (error) => toast.error(`Could not remove ${singular}`, { description: error.message }),
  });

  function submit() {
    const value = draft.trim();
    if (!value || addMutation.isPending) return;
    addMutation.mutate(value);
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isDirectories ? "Directory patterns" : "Aliases"}</DialogTitle>
          <DialogDescription>
            {tool}/{identity.name}
            {isDirectories
              ? ": a pattern without a wildcard matches exactly one directory; a trailing /* covers the tree beneath it."
              : ": short alternate names that resolve to this identity."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          {current.length === 0 ? (
            <p className="rounded-lg border border-dashed px-3 py-4 text-center text-xs text-muted-foreground">
              Nothing configured yet.
            </p>
          ) : (
            <ul className="max-h-48 space-y-1 overflow-y-auto rounded-lg border p-1">
              {current.map((value) => (
                <li
                  key={value}
                  className="flex items-center justify-between gap-3 rounded-md px-2 py-1.5 text-sm hover:bg-accent/60"
                >
                  <span className="truncate font-mono text-xs">{value}</span>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Remove ${value}`}
                    disabled={removeMutation.isPending}
                    onClick={() => removeMutation.mutate(value)}
                  >
                    &times;
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <Input
            className="font-mono text-xs"
            placeholder={isDirectories ? "/home/me/Projects/acme/*" : "wk"}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <Button type="submit" disabled={!draft.trim() || addMutation.isPending}>
            Add
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DeleteIdentityDialog({
  target,
  onClose,
}: {
  target: IdentityRef;
  onClose: () => void;
}) {
  const invalidate = useInvalidateIdentities();
  const mutation = useMutation({
    mutationFn: () => api.deleteIdentity(target.tool, target.identity.name),
    onSuccess: () => {
      invalidate();
      toast.success("Identity deleted", {
        description: `Removed ${target.tool}/${target.identity.name} from the registry.`,
      });
      onClose();
    },
    onError: (error) => toast.error("Delete failed", { description: error.message }),
  });

  return (
    <AlertDialog open onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete identity?</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2">
              <p>
                This removes <span className="font-mono text-xs">{target.identity.name}</span> from
                the <span className="font-mono text-xs">{target.tool}</span> registry only.
              </p>
              <p>
                Its config directory{" "}
                <span className="break-all font-mono text-xs">{target.identity.configDir}</span> is
                left completely untouched on disk, including credentials and session history.
              </p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            disabled={mutation.isPending}
            onClick={(e) => {
              e.preventDefault();
              mutation.mutate();
            }}
          >
            {mutation.isPending ? "Deleting..." : "Delete identity"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function CreateIdentityDialog({ tool, onClose }: { tool: ToolName; onClose: () => void }) {
  const invalidate = useInvalidateIdentities();
  const [name, setName] = useState("");
  const [label, setLabel] = useState("");
  const [description, setDescription] = useState("");
  const [configDir, setConfigDir] = useState("");
  const [directories, setDirectories] = useState("");
  const [aliases, setAliases] = useState("");
  const [apiKey, setApiKey] = useState("");
  const showApiKey = tool === "zai" || tool === "ali";

  const mutation = useMutation({
    mutationFn: () => {
      const body: CreateIdentityBody = {
        name: name.trim(),
        label: label.trim() || name.trim(),
        description: description.trim() || undefined,
        configDir: configDir.trim(),
        directories: directories
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length > 0),
        aliases: aliases
          .split(",")
          .map((part) => part.trim())
          .filter((part) => part.length > 0),
      };
      if (showApiKey && apiKey.length > 0) body.apiKey = apiKey;
      return api.createIdentity(tool, body);
    },
    onSuccess: () => {
      invalidate();
      toast.success("Identity created", { description: `${tool}/${name.trim()}` });
      onClose();
    },
    onError: (error) => toast.error("Create failed", { description: error.message }),
  });

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>New {tool} identity</DialogTitle>
          <DialogDescription>
            Creates an entry in the {tool} registry. The config directory is used as-is; create it
            yourself if it does not exist yet.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="create-name">Name</Label>
            <Input
              id="create-name"
              className="font-mono text-xs"
              placeholder="work"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="create-label">Label</Label>
            <Input
              id="create-label"
              placeholder="Work account"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
          </div>
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="create-configdir">Config directory</Label>
            <Input
              id="create-configdir"
              className="font-mono text-xs"
              placeholder="/home/me/.claude/identities/work"
              value={configDir}
              onChange={(e) => setConfigDir(e.target.value)}
            />
          </div>
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="create-directories">Directory patterns (one per line)</Label>
            <Textarea
              id="create-directories"
              rows={3}
              className="font-mono text-xs"
              placeholder={"/home/me/Projects/acme/*\n/home/me/Projects/acme-client"}
              value={directories}
              onChange={(e) => setDirectories(e.target.value)}
            />
          </div>
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="create-aliases">Aliases (comma separated)</Label>
            <Input
              id="create-aliases"
              placeholder="wk, work-cli"
              value={aliases}
              onChange={(e) => setAliases(e.target.value)}
            />
          </div>
          {showApiKey ? (
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="create-apikey">API key (optional)</Label>
              <Input
                id="create-apikey"
                type="password"
                autoComplete="new-password"
                placeholder={
                  tool === "zai" ? "Z.ai API key written to crush.json" : "Alibaba API key written to crush.json"
                }
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Forwarded to this identity's auth file only; it is never stored in the registry or
                shown again.
              </p>
            </div>
          ) : null}
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="create-description">Description (optional)</Label>
            <Input
              id="create-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending || !name.trim() || !configDir.trim()}
          >
            Create identity
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RegistryTable({ registry }: { registry: RegistryDto }) {
  const [editing, setEditing] = useState<IdentityRef | null>(null);
  const [managing, setManaging] = useState<{ ref: IdentityRef; kind: "directories" | "aliases" } | null>(null);
  const [deleting, setDeleting] = useState<IdentityRef | null>(null);

  if (registry.identities.length === 0) {
    return (
      <p className="rounded-lg border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
        No identities in this registry yet. Use "New identity" to add one.
      </p>
    );
  }

  return (
    <>
      <div className="overflow-hidden rounded-xl border">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Name</TableHead>
              <TableHead>Label</TableHead>
              <TableHead>Aliases</TableHead>
              <TableHead>Directories</TableHead>
              <TableHead>Config dir</TableHead>
              <TableHead className="w-12" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {registry.identities.map((identity) => (
              <TableRow key={identity.name}>
                <TableCell className="font-medium">{identity.name}</TableCell>
                <TableCell className="max-w-44 truncate text-muted-foreground" title={identity.description}>
                  {identity.label}
                </TableCell>
                <TableCell>
                  {(identity.aliases?.length ?? 0) === 0 ? (
                    <span className="text-muted-foreground">-</span>
                  ) : (
                    <div className="flex flex-wrap gap-1">
                      {(identity.aliases ?? []).map((alias) => (
                        <Badge key={alias} variant="secondary" className="font-mono text-[10px]">
                          {alias}
                        </Badge>
                      ))}
                    </div>
                  )}
                </TableCell>
                <TableCell className="tabular-nums">
                  <span
                    title={(identity.directories ?? []).join("\n")}
                    className="cursor-default"
                  >
                    {identity.directories?.length ?? 0}
                  </span>
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <Badge variant={identity.configDirExists ? "success" : "warning"}>
                      {identity.configDirExists ? "Found" : "Missing"}
                    </Badge>
                    <span
                      className="hidden max-w-52 truncate font-mono text-xs text-muted-foreground lg:inline"
                      title={identity.configDir}
                    >
                      {identity.configDir}
                    </span>
                  </div>
                </TableCell>
                <TableCell>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${identity.name}`}>
                        <Ellipsis aria-hidden />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onSelect={() => setEditing({ tool: registry.toolName, identity })}>
                        Edit details
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onSelect={() =>
                          setManaging({ ref: { tool: registry.toolName, identity }, kind: "directories" })
                        }
                      >
                        Directory patterns...
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onSelect={() =>
                          setManaging({ ref: { tool: registry.toolName, identity }, kind: "aliases" })
                        }
                      >
                        Aliases...
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        variant="destructive"
                        onSelect={() => setDeleting({ tool: registry.toolName, identity })}
                      >
                        Delete identity...
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {editing ? (
        <EditIdentityDialog tool={editing.tool} identity={editing.identity} onClose={() => setEditing(null)} />
      ) : null}
      {managing ? (
        <PatternsDialog
          tool={managing.ref.tool}
          identity={managing.ref.identity}
          kind={managing.kind}
          onClose={() => setManaging(null)}
        />
      ) : null}
      {deleting ? (
        <DeleteIdentityDialog target={deleting} onClose={() => setDeleting(null)} />
      ) : null}
    </>
  );
}

export function IdentitiesPage() {
  const query = useIdentitiesQuery();
  const registries = query.data?.registries ?? [];
  const [activeTool, setActiveTool] = useState<string>("");
  const [creatingFor, setCreatingFor] = useState<RegistryDto | null>(null);

  const active =
    registries.find((r) => r.toolName === activeTool) ?? registries[0] ?? null;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Identities"
        description="Every registry AiProfileSwitcher resolves identities from."
        updatedAt={query.dataUpdatedAt}
        actions={
          <Button size="sm" disabled={!active} onClick={() => active && setCreatingFor(active)}>
            <Plus aria-hidden />
            New identity
          </Button>
        }
      />

      {query.isLoading ? (
        <div className="space-y-3">
          <div className="h-9 w-96 animate-pulse rounded-lg bg-muted" />
          <div className="h-64 animate-pulse rounded-xl bg-muted" />
        </div>
      ) : registries.length === 0 ? (
        <p className="rounded-lg border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
          No registries found.
        </p>
      ) : (
        <Tabs value={active?.toolName ?? ""} onValueChange={setActiveTool}>
          <TabsList className="h-auto w-full flex-wrap justify-start">
            {registries.map((r) => (
              <TabsTrigger key={r.toolName} value={r.toolName} className="gap-2 px-3">
                <span className="font-mono text-xs">{r.toolName}</span>
                <Badge variant="secondary" className="px-1.5 font-normal">
                  {r.identities.length}
                </Badge>
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      )}

      {active ? (
        <div className="space-y-3">
          <p className="font-mono text-xs text-muted-foreground" title={active.path}>
            {active.path}
          </p>
          <RegistryTable key={active.toolName} registry={active} />
        </div>
      ) : null}

      {creatingFor ? (
        <CreateIdentityDialog tool={creatingFor.toolName} onClose={() => setCreatingFor(null)} />
      ) : null}
    </div>
  );
}

export default IdentitiesPage;
