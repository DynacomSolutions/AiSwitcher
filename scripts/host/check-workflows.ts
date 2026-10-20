import { readFileSync } from "node:fs";

type Job = {
  "runs-on"?: unknown; permissions?: Record<string, string>; needs?: string | string[];
  if?: string; steps?: Array<Record<string, unknown>>; strategy?: { matrix?: { include?: Array<Record<string, string>> } };
  [key: string]: unknown;
};
export type Workflow = { on: Record<string, unknown>; permissions: Record<string, string>; jobs: Record<string, Job> };

export function aggregatePassed(changes: string, selection: string, checks: string, native: string): boolean {
  if (changes !== "success") return false;
  if (selection === "skip") return checks === "skipped" && native === "skipped";
  return ["host", "all"].includes(selection) && checks === "success" && native === "success";
}

export function checkWorkflow(workflow: Workflow, release: boolean): string[] {
  const errors: string[] = [];
  const allowed = ["ubuntu-latest", "macos-latest", "windows-latest"];
  if (JSON.stringify(workflow.permissions) !== '{"contents":"read"}') errors.push("Default permissions must be contents: read only.");
  if ("schedule" in workflow.on || "pull_request_target" in workflow.on) errors.push("Unsupported workflow trigger.");
  for (const [name, job] of Object.entries(workflow.jobs)) {
    if ("container" in job || "services" in job) errors.push(`${name}: container execution is forbidden.`);
    if (job.permissions && (!release || name !== "release" || JSON.stringify(job.permissions) !== '{"contents":"write"}')) {
      errors.push(`${name}: only the release job may grant contents: write.`);
    }
    if ("secrets" in job) errors.push(`${name}: reusable workflows must not inherit signing secrets.`);
    if (job["runs-on"]) {
      const runners = job["runs-on"] === "${{ matrix.runner }}"
        ? job.strategy?.matrix?.include?.map((entry) => entry.runner) ?? []
        : [job["runs-on"]];
      if (runners.length === 0 || runners.some((runner) => typeof runner !== "string" || !allowed.includes(runner))) errors.push(`${name}: unsupported runner.`);
      for (const entry of job.strategy?.matrix?.include ?? []) {
        if (entry.runner === "macos-latest" && entry.target !== "aarch64-apple-darwin") errors.push(`${name}: macOS is arm64 only.`);
      }
    } else if (job.uses !== "./.github/workflows/host-app.yml") errors.push(`${name}: unexpected reusable workflow.`);
    const text = JSON.stringify(job);
    if (!release && /secrets\./.test(text)) errors.push(`${name}: PR checks cannot reference secrets.`);
    if (/docker:\/\//.test(text) || /\b(?:docker|podman|cross)\s+(?:build|run)\b/.test(text)) errors.push(`${name}: container build is forbidden.`);
  }
  if (!release) {
    if (workflow.jobs.gate?.if !== "${{ always() }}") errors.push("The aggregate must always run.");
    if (JSON.stringify(workflow.jobs.gate?.needs) !== '["changes","checks","native"]') errors.push("The aggregate must cover every required job.");
  } else {
    const calls = workflow.jobs.checks;
    if (calls?.uses !== "./.github/workflows/host-app.yml" || (calls.with as Record<string, unknown>)?.production !== true) errors.push("Release must run the full production checks.");
    if ((calls?.with as Record<string, unknown>)?.ref !== "${{ needs.validate.outputs.sha }}") errors.push("Release checks must use the validated commit.");
    if (calls?.needs !== "validate") errors.push("Release checks must depend on tag validation.");
    if (!JSON.stringify(workflow.jobs.validate).includes("validate-tag")) errors.push("Release must validate its tag against main.");
    if (workflow.jobs.release?.if !== "${{ needs.sign.outputs.ready == 'true' }}") errors.push("An unsigned Mac build cannot become a release.");
    if (JSON.stringify(workflow.jobs.release?.needs) !== '["validate","checks","sign"]') errors.push("Release must depend on validation, checks and signing.");
    if (JSON.stringify(workflow.jobs.sign?.needs) !== '["validate","checks"]') errors.push("Signing must depend on validation and checks.");
    for (const [name, job] of Object.entries(workflow.jobs)) {
      for (const step of job.steps ?? []) {
        if (name !== "validate" && String(step.uses ?? "").startsWith("actions/checkout@")
          && (step.with as Record<string, unknown>)?.ref !== "${{ needs.validate.outputs.sha }}") {
          errors.push(`${name}: checkout must use the validated commit.`);
        }
      }
    }
  }
  return errors;
}

if (import.meta.main) {
  if (Bun.argv.includes("--gate")) {
    const env = process.env;
    if (!aggregatePassed(env.CHANGES_RESULT ?? "", env.SELECTION ?? "", env.CHECKS_RESULT ?? "", env.NATIVE_RESULT ?? "")) {
      throw new Error("Required host checks failed, were cancelled or were unexpectedly skipped.");
    }
  } else {
    const errors = ["host-app", "release-host-app"].flatMap((name) =>
      checkWorkflow(Bun.YAML.parse(readFileSync(`.github/workflows/${name}.yml`, "utf8")) as Workflow, name.startsWith("release")));
    if (errors.length) throw new Error(errors.join("\n"));
    console.log("Host workflow policy passed.");
  }
}
