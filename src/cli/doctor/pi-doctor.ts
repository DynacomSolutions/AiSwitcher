import { reconcilePiOAuthStores, renderOAuthReconcileReport } from "../../identities/oauth-reconcile.ts";
import type { Identity } from "../../identities/types.ts";
import type { DoctorResult } from "./types.ts";

/**
 * pi has no single upstream binary health story to probe (it is a
 * multi-provider agent), so its doctor check verifies the credential
 * pipeline AIS itself owns: the ONE-credential-per-(identity, provider)
 * projections (src/identities/oauth-reconcile.ts). Diverged copies of the
 * same account (different refresh-token fingerprints) mean two stores are
 * refreshing one grant independently - the forced-re-login bug - so the
 * identity reports degraded with the fingerprints, the drift and the
 * remediation. Read-only: the probe never rewrites; the heal happens on
 * the next pi launch or `ais auth sync`.
 */
export async function probePiDoctor(identity: Identity): Promise<DoctorResult> {
  const base = { toolName: "pi" as const, identity };
  const report = await reconcilePiOAuthStores(identity, { write: false });
  const checked = report.entries.filter((entry) => entry.status !== "unreadable");
  const forked = report.entries.filter((entry) => entry.status === "forked");
  const failed = report.entries.filter((entry) => entry.status === "failed");
  if (forked.length === 0 && failed.length === 0) {
    return {
      ...base,
      status: "responsive",
      statusWord: "in sync",
      detail:
        checked.length > 0
          ? `${checked.length} OAuth projection${checked.length === 1 ? "" : "s"} checked, no diverged copies`
          : "no native counterpart identities to reconcile against",
    };
  }
  const lines = renderOAuthReconcileReport({ ...report, entries: [...forked, ...failed] });
  return {
    ...base,
    status: "degraded",
    statusWord: "forked",
    detail:
      `${forked.length} OAuth credential fork${forked.length === 1 ? "" : "s"} detected; ` +
      `${lines.join(" | ")}; launch pi (the wrapper self-heals) or run ` +
      "`ais auth sync --tool=pi " + identity.name + "` to adopt the freshest copy, " +
      "and re-login the store whose copy still fails afterwards",
  };
}
