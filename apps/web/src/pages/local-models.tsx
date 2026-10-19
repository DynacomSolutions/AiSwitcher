import { WifiOff } from "lucide-react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";

import { EmptyState, ErrorBanner, PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useLocalModelsQuery } from "@/hooks/queries";
import { modelPath, readFilter, withFilter } from "@/lib/local-models-url";

const mib = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;

/** Quote for a POSIX shell only when the name needs it. */
const shellArg = (s: string) => (/^[\w.@%+=:,/-]+$/.test(s) ? s : `'${s.replaceAll("'", "'\\''")}'`);

export function LocalModelsPage() {
  const query = useLocalModelsQuery();
  const navigate = useNavigate();
  const { name } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const filter = readFilter(searchParams);
  const open = (n: string) => navigate({ pathname: modelPath(n), search: searchParams.toString() });
  const data = query.data;

  const needle = filter.trim().toLowerCase();
  const visible = (data?.models ?? []).filter((m) => m.name.toLowerCase().includes(needle));
  const selected = name === undefined ? undefined : data?.models.find((m) => m.name === name);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Local Models"
        description="GGUF models found on this machine. They run without an identity or internet access."
        updatedAt={query.dataUpdatedAt}
      />
      {query.isError ? <ErrorBanner message={query.error.message} /> : null}
      {query.isLoading ? <Skeleton className="h-40 w-full" /> : null}
      {data && !data.online ? (
        <div className="flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/12 px-3 py-2.5 text-sm text-amber-600 dark:text-amber-400">
          <WifiOff aria-hidden className="size-4 shrink-0" />
          <span>Offline: hosted tools need internet, local models still work.</span>
        </div>
      ) : null}
      {data && data.runner === null ? (
        <Badge variant="warning">Runner missing: install llama-cli or set AIS_LLAMA_BIN to start models</Badge>
      ) : null}
      {data ? (
        <>
          {name !== undefined ? (
            <Card>
              <CardContent className="space-y-2 pt-6 text-sm">
                {selected ? (
                  <>
                    <h2 className="font-semibold">{selected.name}</h2>
                    <p className="font-mono text-xs break-all">{selected.path}</p>
                    <p className="text-muted-foreground">{mib(selected.sizeBytes)}</p>
                    <p>Start it from a terminal (the console never starts models):</p>
                    <code className="bg-muted block rounded-md px-3 py-2 font-mono text-xs select-all">
                      ais local start {shellArg(selected.name)}
                    </code>
                  </>
                ) : (
                  <ErrorBanner message={`No local model named ${name}.`} />
                )}
              </CardContent>
            </Card>
          ) : null}
          <Input
            value={filter}
            onChange={(e) => setSearchParams(withFilter(searchParams, e.target.value), { replace: true })}
            placeholder="Filter by name"
            aria-label="Filter models"
            className="h-8 max-w-xs text-xs"
          />
          {data.models.length === 0 ? (
            <EmptyState title="No local models" description="Place a .gguf file in ~/.ais/models to list it here." />
          ) : visible.length === 0 ? (
            <EmptyState title="No matches" description="No model name contains that filter." />
          ) : (
            <Card>
              <CardContent className="pt-6">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>Size</TableHead>
                      <TableHead>Path</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {visible.map((m) => (
                      <TableRow
                        key={m.name}
                        data-state={m.name === name ? "selected" : undefined}
                        role="button"
                        tabIndex={0}
                        aria-label={`Open model: ${m.name}`}
                        className="cursor-pointer focus-visible:outline-2 focus-visible:outline-ring"
                        onClick={() => open(m.name)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            open(m.name);
                          }
                        }}
                      >
                        <TableCell className="font-medium">{m.name}</TableCell>
                        <TableCell className="tabular-nums">{mib(m.sizeBytes)}</TableCell>
                        <TableCell className="font-mono text-xs break-all">{m.path}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}
        </>
      ) : null}
    </div>
  );
}
