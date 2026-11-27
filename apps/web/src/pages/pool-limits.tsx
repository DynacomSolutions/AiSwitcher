import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { qk } from "@/hooks/queries";
import { api } from "@/lib/api";
import { formatResetTimes } from "@/lib/reset-time";
import { ToolBadge } from "@/components/badges";
import { ErrorBanner, PageHeader } from "@/components/page-header";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import type { PoolResetCandidate, PoolResetReview } from "@/types/api";

const availabilityMessage: Record<PoolResetReview["availability"], string> = {
  available: "The gateway checked the credit and account against live provider data.",
  below_threshold: "Verified pool usage is below 90%.",
  unavailable: "The gateway could not verify current usage or reset credits.",
  no_credit: "This pool has no eligible reset credit.",
  unsupported: "This provider has no supported pool reset credit.",
};

function PoolLimits({ tool, pool }: { tool: string; pool: string }) {
  const client = useQueryClient();
  const [search, setSearch] = useSearchParams();
  const open = search.get("reset") === "1";
  const setOpen = (value: boolean) => setSearch((previous) => {
    const next = new URLSearchParams(previous);
    if (value) next.set("reset", "1");
    else next.delete("reset");
    return next;
  }, { replace: true });
  const key = ["pool-reset-review", tool, pool, open] as const;
  const query = useQuery({
    queryKey: key,
    queryFn: () => api.getPoolResetReview(tool, pool),
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
    retry: false,
  });
  const reviewButton = useRef<HTMLButtonElement>(null);
  const inFlight = useRef(false);
  const action = useMutation({
    mutationFn: (candidate: PoolResetCandidate) =>
      api.confirmPoolReset(tool, pool, { candidate, redeemRequestId: crypto.randomUUID() }),
    retry: false,
    onSuccess: (result) => {
      if (result.status === "changed") {
        client.setQueryData(key, result.review);
      } else {
        void client.invalidateQueries({ queryKey: qk.limits });
        void client.invalidateQueries({ queryKey: qk.poolsUsage });
      }
    },
    onSettled: () => { inFlight.current = false; },
  });
  const review = query.data;
  const result = action.data?.status;
  const done = result !== undefined && result !== "changed";
  const candidate = query.isFetching || query.isError || done || action.isError ? undefined : review?.candidate;
  const submit = () => {
    if (!candidate || inFlight.current) return;
    inFlight.current = true;
    action.mutate(candidate);
  };
  const status = action.isError ? action.error.message
    : action.isPending ? "Checking the confirmed account and credit."
    : result === "changed" ? "The selection changed. Review the current details before confirming."
    : result === "confirmed" ? "The provider accepted the reset and fresh usage confirms the change."
    : result === "pending" ? "The gateway has yet to verify the reset. Check current limits before you consider another reset."
    : result === "already_attempted" ? "The gateway already recorded an attempt for this credit. Check current limits."
    : result === "declined" ? "The provider did not apply a reset. Review current limits."
    : undefined;
  const changeOpen = (value: boolean) => {
    if (inFlight.current) return;
    action.reset();
    setOpen(value);
  };

  return (
    <div className="space-y-5">
      <PageHeader title={pool} description="Pool usage and reset review" />
      <Button asChild variant="outline" size="sm"><Link to="/limits">Back to Limits</Link></Button>
      {query.isError && !open ? <ErrorBanner message={query.error.message} /> : null}
      <Card>
        <CardContent className="space-y-3">
          <ToolBadge tool={tool} />
          <p className="text-sm">{review?.percent === undefined ? "Verified pool usage is unavailable." : `${review.percent.toFixed(1)}% used`}</p>
          {review?.members.length ? <p className="text-sm text-muted-foreground break-words">{review.members.join(", ")}</p> : null}
          <Button ref={reviewButton} size="sm" onClick={() => changeOpen(true)}>Review reset</Button>
        </CardContent>
      </Card>
      <AlertDialog open={open} onOpenChange={changeOpen}>
        <AlertDialogContent onCloseAutoFocus={(event) => {
          event.preventDefault();
          reviewButton.current?.focus();
        }}>
          <AlertDialogHeader>
            <AlertDialogTitle>Review pool reset</AlertDialogTitle>
            <AlertDialogDescription className="break-words">
              {pool}. {query.isFetching ? "Checking live usage and reset credits."
                : query.isError ? query.error.message
                : review ? availabilityMessage[review.availability] : "Checking reset availability."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {candidate ? (
            <dl className="grid gap-2 break-words text-sm">
              <div><dt className="text-muted-foreground">Account</dt><dd className="font-medium">{candidate.identity}</dd></div>
              <div><dt className="text-muted-foreground">Credit</dt><dd className="font-medium">{candidate.creditId}</dd></div>
              <div><dt className="text-muted-foreground">Credit expires</dt><dd>{formatResetTimes(candidate.creditExpiresAt)}</dd></div>
              <div><dt className="text-muted-foreground">Weekly limit resets</dt><dd>{formatResetTimes(candidate.weeklyReset)}</dd></div>
            </dl>
          ) : null}
          {status ? <p role="status" className="text-sm">{status}</p> : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={action.isPending}>{candidate ? "Cancel" : "Close"}</AlertDialogCancel>
            {candidate ? <Button disabled={action.isPending} onClick={submit}>Confirm and use reset</Button> : null}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export function PoolLimitsPage() {
  const { tool = "", pool = "" } = useParams();
  return <PoolLimits key={JSON.stringify([tool, pool])} tool={tool} pool={pool} />;
}
