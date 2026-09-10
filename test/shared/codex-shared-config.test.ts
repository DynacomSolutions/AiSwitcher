import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import * as TOOL_CONFIGS from "../../src/identities/tool-configs.ts";
import { projectSharedCodexConfigForLaunch as projectGlobalCodexMcpForLaunch } from "../../src/shared/codex-shared-config.ts";
import { codexPlatformArgs } from "../../src/shared/codex-platform-config.ts";

const homes: string[] = [];
const codex = { toolName: "codex" } as const;
const argv = ["exec", "hello"];
const globalConfig = `
[mcp_servers.graph]
command = "graph-server"
args = []
env_vars = ["CBM_CACHE_DIR", "CBM_RUNTIME_DIR"]
`;

async function fixture(source = globalConfig) {
  const home = await mkdtemp(join(tmpdir(), "ais-codex-mcp-"));
  homes.push(home);
  const shared = join(home, ".codex", "config.toml");
  const identity = join(home, ".codex", "identities", "fresh");
  await mkdir(join(home, ".codex"), { recursive: true });
  await writeFile(shared, source);
  return { home, shared, identity };
}

async function localConfig(identity: string, source: string) {
  await mkdir(identity, { recursive: true });
  await writeFile(join(identity, "config.toml"), source);
}

function projected(args: string[]): Record<string, any> {
  expect(args[0]).toBe("-c");
  const config = parseToml(args[1]!);
  expect(Object.keys(config)).toEqual(["mcp_servers"]);
  return config.mcp_servers as Record<string, any>;
}

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe("global Codex MCP launch defaults", () => {
  test("fresh identity inherits only MCP settings without creating an identity file", async () => {
    const { home, identity, shared } = await fixture();
    const result = await projectGlobalCodexMcpForLaunch(codex, identity, argv, home);
    expect(projected(result)).toEqual({
      graph: { command: "graph-server", args: [], env_vars: ["CBM_CACHE_DIR", "CBM_RUNTIME_DIR"] },
    });
    expect(result.slice(2)).toEqual(argv);
    expect(await readFile(shared, "utf8")).toBe(globalConfig);
    expect(await readdir(join(home, ".codex"))).toEqual(["config.toml"]);
  });

  test("global edits, additions and removals take effect on the next launch", async () => {
    const { home, identity, shared } = await fixture();
    await localConfig(identity, '[mcp_servers.local]\ncommand = "local-only"\n');
    expect(projected(await projectGlobalCodexMcpForLaunch(codex, identity, argv, home)).graph.command)
      .toBe("graph-server");
    await writeFile(shared, '[mcp_servers.replacement]\ncommand = "updated-server"\n');
    expect(projected(await projectGlobalCodexMcpForLaunch(codex, identity, argv, home))).toEqual({
      replacement: { command: "updated-server" },
    });
    await writeFile(shared, 'model_provider = "still-private"\n');
    expect(await projectGlobalCodexMcpForLaunch(codex, identity, argv, home)).toBe(argv);
  });

  test("identity transport, arrays, environment and nested tool approvals override defaults", async () => {
    const { home, identity } = await fixture(globalConfig + `
[mcp_servers.graph.env]
SHARED = "shared"
OVERRIDE = "global"
[mcp_servers.graph.tools.list_projects]
approval_mode = "prompt"
[mcp_servers.global_only]
command = "shared-only"
`);
    const local = `
model = "local-model"
[mcp_servers.graph]
command = "local-server"
args = ["local"]
env_vars = []
[mcp_servers.graph.env]
OVERRIDE = "local"
[mcp_servers.graph.tools.list_projects]
approval_mode = "approve"
[mcp_servers.graph.tools.get_architecture]
approval_mode = "approve"
[mcp_servers.local_only]
command = "identity-only"
`;
    await localConfig(identity, local);
    const before = await stat(join(identity, "config.toml"));
    const result = projected(await projectGlobalCodexMcpForLaunch(codex, identity, argv, home));
    expect(result.graph).toEqual({
      env: { SHARED: "shared" },
    });
    expect(result.global_only.command).toBe("shared-only");
    expect(result.local_only).toBeUndefined();
    expect(await readFile(join(identity, "config.toml"), "utf8")).toBe(local);
    expect((await stat(join(identity, "config.toml"))).mtimeMs).toBe(before.mtimeMs);
  });

  test("identity enabled=false opts out while inheriting required transport fields", async () => {
    const { home, identity } = await fixture();
    await localConfig(identity, "[mcp_servers.graph]\nenabled = false\n");
    expect(projected(await projectGlobalCodexMcpForLaunch(codex, identity, argv, home)).graph)
      .toEqual({ command: "graph-server", args: [], env_vars: ["CBM_CACHE_DIR", "CBM_RUNTIME_DIR"] });
    expect(await readFile(join(identity, "config.toml"), "utf8")).toContain("enabled = false");
  });

  test("global disable remains a default that an identity can override", async () => {
    const { home, identity } = await fixture(globalConfig + "enabled = false\n");
    expect(projected(await projectGlobalCodexMcpForLaunch(codex, identity, argv, home)).graph.enabled).toBe(false);
    await localConfig(identity, "[mcp_servers.graph]\nenabled = true\n");
    expect(projected(await projectGlobalCodexMcpForLaunch(codex, identity, argv, home)).graph.enabled).toBeUndefined();
    expect(await readFile(join(identity, "config.toml"), "utf8")).toContain("enabled = true");
  });

  test("tool approvals alone retain shared transport without forwarding identity values", async () => {
    const { home, identity } = await fixture();
    await localConfig(identity, `
[mcp_servers.graph.tools.list_projects]
approval_mode = "approve"
[mcp_servers.graph.tools.get_architecture]
approval_mode = "approve"
`);
    expect(projected(await projectGlobalCodexMcpForLaunch(codex, identity, argv, home)).graph).toEqual({
      command: "graph-server", args: [], env_vars: ["CBM_CACHE_DIR", "CBM_RUNTIME_DIR"],
    });
    expect(await readFile(join(identity, "config.toml"), "utf8")).toContain('approval_mode = "approve"');
  });

  test("identity credentials, including unrelated servers, never appear in projected argv", async () => {
    const { home, identity } = await fixture(globalConfig + `
[mcp_servers.graph.env]
TOKEN = "shared-value-overridden-locally"
`);
    await localConfig(identity, `
[mcp_servers.graph.env]
TOKEN = "local-credential-sentinel"
[mcp_servers.private_server]
url = "https://example.invalid/mcp"
http_headers = { Authorization = "private-credential-sentinel" }
`);
    const result = await projectGlobalCodexMcpForLaunch(codex, identity, argv, home);
    expect(projected(result).graph).toEqual({
      command: "graph-server", args: [], env_vars: ["CBM_CACHE_DIR", "CBM_RUNTIME_DIR"],
    });
    expect(result.join(" ")).not.toContain("credential-sentinel");
    expect(result.join(" ")).not.toContain("shared-value-overridden-locally");
    expect(result.join(" ")).not.toContain("private_server");
  });

  test("explicit HTTP transport omits all shared stdio fields but retains common defaults", async () => {
    const { home, identity } = await fixture(globalConfig + `
cwd = "/shared/workspace"
env = { SHARED = "stdio-only" }
startup_timeout_sec = 15
`);
    await localConfig(identity, '[mcp_servers.graph]\nurl = "https://example.invalid/mcp"\n');
    expect(projected(await projectGlobalCodexMcpForLaunch(codex, identity, argv, home))).toEqual({
      graph: { startup_timeout_sec: 15 },
    });
  });

  test("explicit stdio transport omits shared HTTP fields but retains common defaults", async () => {
    const { home, identity } = await fixture(`
[mcp_servers.graph]
url = "https://example.invalid/mcp"
bearer_token_env_var = "SHARED_TOKEN"
http_headers = { Authorization = "shared-header-sentinel" }
env_http_headers = { "X-Token" = "TOKEN" }
http_headers_helper = "shared-helper"
oauth = { callback_port = 9876 }
oauth_resource = "shared-resource"
auth = { type = "oauth" }
tool_timeout_sec = 25
`);
    await localConfig(identity, '[mcp_servers.graph]\ncommand = "local-server"\n');
    expect(projected(await projectGlobalCodexMcpForLaunch(codex, identity, argv, home))).toEqual({
      graph: { tool_timeout_sec: 25 },
    });
  });

  test("fully specified identity defaults need no overlay, including repeated launches", async () => {
    const { home, identity } = await fixture();
    await localConfig(identity, globalConfig);
    for (let launch = 0; launch < 2; launch++) {
      expect(await projectGlobalCodexMcpForLaunch(codex, identity, argv, home)).toBe(argv);
    }
    expect(await readFile(join(identity, "config.toml"), "utf8")).toBe(globalConfig);
  });

  test("quoted names, inline tables and escaped environment values round trip as TOML", async () => {
    const source = String.raw`
[mcp_servers.'graph.name = "quoted"']
command = 'C:\tools\graph'
args = ["--query=a=b", "line\nbreak", "\"quoted\"", "tab\tvalue", "form\fvalue"]
env = { "a.b" = "quotes: \" backslash: \\ del: \u007f", 'a=b' = "\u96EA \U0001F600" }
startup_timeout_sec = 1.5
`;
    const { home, identity } = await fixture(source);
    expect(projected(await projectGlobalCodexMcpForLaunch(codex, identity, argv, home))).toEqual({
      'graph.name = "quoted"': {
        command: "C:\\tools\\graph",
        args: ["--query=a=b", "line\nbreak", '"quoted"', "tab\tvalue", "form\fvalue"],
        env: { "a.b": 'quotes: " backslash: \\ del: \x7f', "a=b": "雪 😀" },
        startup_timeout_sec: 1.5,
      },
    });
  });

  test("escaped tabs and formfeeds retain their distinct TOML character codes", async () => {
    const { home, identity } = await fixture(String.raw`
[mcp_servers.graph]
command = "graph-server"
args = ["a\tb", "a\fb"]
env = { TAB = "a\tb", FORMFEED = "a\fb" }
`);
    const graph = projected(await projectGlobalCodexMcpForLaunch(codex, identity, argv, home)).graph;
    expect(graph.args).toEqual(["a\tb", "a\fb"]);
    expect(graph.env).toEqual({ TAB: "a\tb", FORMFEED: "a\fb" });
    expect(Array.from(graph.args[0] as string, (character) => character.charCodeAt(0))).toEqual([97, 9, 98]);
    expect(Array.from(graph.args[1] as string, (character) => character.charCodeAt(0))).toEqual([97, 12, 98]);
  });

  test("invocation overrides remain later than the projection, including subcommand flags", async () => {
    const { home, identity } = await fixture();
    const explicit = [
      "--config", 'mcp_servers.graph.command="cli-server"',
      "exec", "-c", "mcp_servers.graph.enabled=false",
      "--config=mcp_servers.graph.args=[]", "--", "literal -c mcp_servers={}",
    ];
    const result = await projectGlobalCodexMcpForLaunch(codex, identity, explicit, home);
    expect(projected(result).graph.command).toBe("graph-server");
    expect(result.slice(2)).toEqual(explicit);
  });

  test("the existing platform disable follows shared projection and precedes user overrides", async () => {
    const { home, identity } = await fixture();
    await localConfig(identity, `
[mcp_servers.node_repl]
command = "/Applications/Codex.app/Contents/Resources/node_repl"
`);
    const platform = codexPlatformArgs(identity, argv, { platform: "linux", commandExists: () => false });
    const result = await projectGlobalCodexMcpForLaunch(codex, identity, platform, home);
    expect(projected(result).node_repl).toBeUndefined();
    expect(result.slice(2)).toEqual(["-c", "mcp_servers.node_repl.enabled=false", ...argv]);
  });

  test("using the global home directly or through an alias adds nothing and writes nothing", async () => {
    const { home, shared } = await fixture();
    const alias = join(home, "alias");
    await symlink(join(home, ".codex"), alias);
    const before = await stat(shared);
    for (const identity of [join(home, ".codex"), alias]) {
      expect(await projectGlobalCodexMcpForLaunch(codex, identity, argv, home)).toBe(argv);
    }
    expect(await readFile(shared, "utf8")).toBe(globalConfig);
    expect((await stat(shared)).mtimeMs).toBe(before.mtimeMs);
  });

  test("a completely fresh user home without global config remains unchanged", async () => {
    const { home, identity, shared } = await fixture();
    await rm(shared);
    expect(await projectGlobalCodexMcpForLaunch(codex, identity, argv, home)).toBe(argv);
    expect(await readdir(join(home, ".codex"))).toEqual([]);
  });

  test("non-Codex tools neither read nor project even malformed global config", async () => {
    const { home, identity } = await fixture("not valid TOML!");
    for (const cfg of Object.values(TOOL_CONFIGS)) {
      if (cfg.toolName === "codex") continue;
      expect(await projectGlobalCodexMcpForLaunch(cfg, identity, argv, home)).toBe(argv);
    }
  });

  test("malformed TOML fails without disclosing source values", async () => {
    const { home, identity, shared } = await fixture('secret = "do-not-print');
    const message = await projectGlobalCodexMcpForLaunch(codex, identity, argv, home)
      .catch((error: Error) => error.message);
    expect(message).toBe(`Invalid TOML in shared Codex configuration: ${shared}`);
    await writeFile(shared, globalConfig);
    await localConfig(identity, 'secret = "identity-do-not-print');
    await expect(projectGlobalCodexMcpForLaunch(codex, identity, argv, home))
      .rejects.toThrow(`Invalid TOML in shared Codex configuration: ${join(identity, "config.toml")}`);
  });
});

const permissionConfig = `
approval_policy = "on-request"
approvals_reviewer = "auto_review"
sandbox_mode = "workspace-write"
`;

function projectedConfig(args: string[], original: string[] = argv): Record<string, unknown> {
  const projection = args.slice(0, args.length - original.length);
  const config = Object.assign({}, ...projection.filter((_, index) => index % 2 === 1)
    .map((source) => parseToml(source)));
  expect(args.slice(projection.length)).toEqual(original);
  return config;
}

describe("shared Codex permission defaults", () => {
  test("fresh identities inherit automatic review and workspace permissions alongside MCP", async () => {
    const { home, identity, shared } = await fixture(permissionConfig + globalConfig);
    const config = projectedConfig(await projectGlobalCodexMcpForLaunch(codex, identity, argv, home));
    expect(config).toEqual({
      approval_policy: "on-request",
      approvals_reviewer: "auto_review",
      sandbox_mode: "workspace-write",
      mcp_servers: {
        graph: { command: "graph-server", args: [], env_vars: ["CBM_CACHE_DIR", "CBM_RUNTIME_DIR"] },
      },
    });
    expect(await readFile(shared, "utf8")).toBe(permissionConfig + globalConfig);
    expect(await readdir(join(home, ".codex"))).toEqual(["config.toml"]);
  });

  test("permission defaults work without any shared MCP servers and refresh next launch", async () => {
    const { home, identity, shared } = await fixture(permissionConfig);
    expect(projectedConfig(await projectGlobalCodexMcpForLaunch(codex, identity, argv, home)))
      .toEqual(parseToml(permissionConfig));
    await writeFile(shared, 'approvals_reviewer = "user"\n');
    expect(projectedConfig(await projectGlobalCodexMcpForLaunch(codex, identity, argv, home)))
      .toEqual({ approvals_reviewer: "user" });
  });

  test("shared permissions override stale identity writes without rewriting the identity file", async () => {
    const { home, identity } = await fixture(permissionConfig);
    const local = 'approval_policy = "never"\napprovals_reviewer = "user"\nsandbox_mode = "read-only"\n';
    await localConfig(identity, local);
    expect(projectedConfig(await projectGlobalCodexMcpForLaunch(codex, identity, argv, home)))
      .toEqual(parseToml(permissionConfig));
    expect(await readFile(join(identity, "config.toml"), "utf8")).toBe(local);
  });

  test("shared Full Access overrides stale local workspace and on-request permissions", async () => {
    const { home, identity } = await fixture(`
approval_policy = "never"
approvals_reviewer = "auto_review"
sandbox_mode = "danger-full-access"
`);
    const local = 'approval_policy = "on-request"\napprovals_reviewer = "user"\nsandbox_mode = "workspace-write"\n';
    await localConfig(identity, local);
    expect(projectedConfig(await projectGlobalCodexMcpForLaunch(codex, identity, argv, home))).toEqual({
      approval_policy: "never", approvals_reviewer: "auto_review", sandbox_mode: "danger-full-access",
    });
    expect(await readFile(join(identity, "config.toml"), "utf8")).toBe(local);
  });

  test("shared approval policy overrides a local granular policy", async () => {
    const { home, identity } = await fixture(permissionConfig);
    await localConfig(identity, "approval_policy = { granular = { sandbox_approval = false } }\n");
    expect(projectedConfig(await projectGlobalCodexMcpForLaunch(codex, identity, argv, home))).toEqual({
      approval_policy: "on-request", approvals_reviewer: "auto_review", sandbox_mode: "workspace-write",
    });
  });

  test("legacy workspace compatibility settings are inherited together on a fresh identity", async () => {
    const { home, identity } = await fixture(permissionConfig + `
[sandbox_workspace_write]
network_access = false
writable_roots = ["/shared/workspace"]
`);
    expect(projectedConfig(await projectGlobalCodexMcpForLaunch(codex, identity, argv, home))).toEqual({
      approval_policy: "on-request", approvals_reviewer: "auto_review", sandbox_mode: "workspace-write",
      sandbox_workspace_write: { network_access: false, writable_roots: ["/shared/workspace"] },
    });
  });

  test("a local named permission profile suppresses incompatible shared sandbox representation", async () => {
    const { home, identity } = await fixture(permissionConfig + `
[sandbox_workspace_write]
network_access = false
`);
    const local = 'default_permissions = "identity-profile"\n';
    await localConfig(identity, local);
    expect(projectedConfig(await projectGlobalCodexMcpForLaunch(codex, identity, argv, home))).toEqual({
      approval_policy: "on-request", approvals_reviewer: "auto_review",
    });
    expect(await readFile(join(identity, "config.toml"), "utf8")).toBe(local);
  });

  test("shared legacy sandbox settings override local legacy fields", async () => {
    const source = permissionConfig + "[sandbox_workspace_write]\nnetwork_access = false\n";
    const { home, identity } = await fixture(source);
    await localConfig(identity, 'sandbox_mode = "read-only"\n[sandbox_workspace_write]\nnetwork_access = true\n');
    expect(projectedConfig(await projectGlobalCodexMcpForLaunch(codex, identity, argv, home)))
      .toEqual(parseToml(source));
  });

  test("shared named permissions exclude legacy settings and never override local sandbox choices", async () => {
    const { home, identity } = await fixture('default_permissions = "workspace-write"\n' + permissionConfig);
    expect(projectedConfig(await projectGlobalCodexMcpForLaunch(codex, identity, argv, home))).toEqual({
      approval_policy: "on-request", approvals_reviewer: "auto_review", default_permissions: "workspace-write",
    });
    await localConfig(identity, 'sandbox_mode = "read-only"\n');
    expect(projectedConfig(await projectGlobalCodexMcpForLaunch(codex, identity, argv, home))).toEqual({
      approval_policy: "on-request", approvals_reviewer: "auto_review",
    });
  });

  test("CLI policy and reviewer overrides remain last, including subcommand options", async () => {
    const { home, identity } = await fixture(permissionConfig);
    const explicit = ["-c", 'approval_policy="never"', "exec", "--config=approvals_reviewer=\"user\"", "hello"];
    expect(projectedConfig(await projectGlobalCodexMcpForLaunch(codex, identity, explicit, home), explicit))
      .toEqual(parseToml(permissionConfig));
  });

  test("CLI sandbox choices suppress shared sandbox representations without changing caller arguments", async () => {
    const { home, identity } = await fixture(permissionConfig);
    for (const flags of [
      ["-c", 'default_permissions="read-only"'],
      ["--config=sandbox_mode=\"read-only\""],
      ["-csandbox_workspace_write.network_access=true"],
      ["--sandbox", "read-only"],
      ["--sandbox=read-only"],
      ["-sread-only"],
      ["--approve-for-me"],
    ]) {
      const explicit = [...flags, ...argv];
      expect(projectedConfig(await projectGlobalCodexMcpForLaunch(codex, identity, explicit, home), explicit))
        .toEqual({ approval_policy: "on-request", approvals_reviewer: "auto_review" });
    }
  });

  test("permission-like prompt text after -- does not suppress defaults", async () => {
    const { home, identity } = await fixture(permissionConfig);
    const explicit = ["exec", "--", "--sandbox=read-only"];
    expect(projectedConfig(await projectGlobalCodexMcpForLaunch(codex, identity, explicit, home), explicit))
      .toEqual(parseToml(permissionConfig));
  });
});

const runtimeConfig = `
model = "shared-model"
model_reasoning_effort = "high"
service_tier = "fast"
model_auto_compact_token_limit = 150000
tool_output_token_limit = 12000
[agents]
max_threads = 6
max_depth = 2
[agents.worker]
description = "Shared worker"
config_file = "worker.toml"
[features]
multi_agent = true
[features.multi_agent_v2]
enabled = true
`;

describe("shared Codex runtime baseline", () => {
  test("fresh identities inherit the normal runtime baseline, permissions and MCP only", async () => {
    const excluded = `
model_provider = "private-provider"
openai_base_url = "https://provider.example.invalid"
forced_login_method = "api"
cli_auth_credentials_store = "file"
browser_path = "/private/browser"
trusted_project_hashes = ["private-trust-sentinel"]
[model_providers.private]
base_url = "https://provider.example.invalid"
env_key = "PRIVATE_PROVIDER_KEY"
[auth]
token = "private-auth-sentinel"
[projects."/private/project"]
trust_level = "trusted"
[hooks]
command = "private-hook-sentinel"
[marketplaces.private]
source = "private-marketplace-sentinel"
[plugins.private]
enabled = true
`;
    // Root defaults must precede all TOML table declarations.
    const tableStart = runtimeConfig.indexOf("[agents]");
    const { home, identity } = await fixture(permissionConfig
      + runtimeConfig.slice(0, tableStart) + excluded
      + runtimeConfig.slice(tableStart) + globalConfig);
    const result = await projectGlobalCodexMcpForLaunch(codex, identity, argv, home);
    expect(projectedConfig(result)).toEqual({
      ...parseToml(runtimeConfig),
      ...parseToml(permissionConfig),
      ...parseToml(globalConfig),
    });
    expect(result.join(" ")).not.toContain("private-");
    expect(await readdir(join(home, ".codex"))).toEqual(["config.toml"]);
  });

  test("shared runtime values override local duplicates without forwarding identity-only fields", async () => {
    const { home, identity } = await fixture(runtimeConfig);
    const local = `
model = "bedrock-provider-model"
model_reasoning_effort = "medium"
service_tier = "default"
model_auto_compact_token_limit = 50000
tool_output_token_limit = 2000
model_provider = "bedrock"
[agents]
max_threads = 1
[agents.worker]
config_file = "identity-worker.toml"
[agents.private_worker]
description = "identity-agent-sentinel"
[features]
multi_agent = false
[features.multi_agent_v2]
enabled = false
`;
    await localConfig(identity, local);
    const result = await projectGlobalCodexMcpForLaunch(codex, identity, argv, home);
    const expected = parseToml(runtimeConfig);
    delete expected.model;
    delete expected.service_tier;
    expect(projectedConfig(result)).toEqual(expected);
    expect(result.join(" ")).not.toContain("identity-");
    expect(result.join(" ")).not.toContain("bedrock");
    expect(await readFile(join(identity, "config.toml"), "utf8")).toBe(local);
  });

  test("runtime edits apply next launch and explicit CLI overrides remain last", async () => {
    const { home, identity, shared } = await fixture(runtimeConfig);
    const explicit = ["--model", "cli-model", "exec", "-c", "agents.max_threads=1", "hello"];
    expect(projectedConfig(await projectGlobalCodexMcpForLaunch(codex, identity, explicit, home), explicit))
      .toEqual(parseToml(runtimeConfig));
    await writeFile(shared, 'model_reasoning_effort = "low"\n[features]\nmulti_agent = false\n');
    expect(projectedConfig(await projectGlobalCodexMcpForLaunch(codex, identity, argv, home))).toEqual({
      model_reasoning_effort: "low", features: { multi_agent: false },
    });
  });

  test("shared runtime values remain projected even when duplicated locally", async () => {
    const { home, identity } = await fixture(runtimeConfig);
    await localConfig(identity, runtimeConfig);
    expect(projectedConfig(await projectGlobalCodexMcpForLaunch(codex, identity, argv, home)))
      .toEqual(parseToml(runtimeConfig));
  });

  test("non-OpenAI providers keep their main model and parent-model subagents without a shared service tier", async () => {
    const source = runtimeConfig.replace("[agents]", '[agents]\ndefault_subagent_model = "shared-worker-model"');
    const { home, identity } = await fixture(source);
    const provider = 'model_provider = "amazon-bedrock"\nmodel = "openai.gpt-6-astra"\n';
    const expected = parseToml(runtimeConfig);
    delete expected.model;
    delete expected.service_tier;
    for (const local of [
      provider,
      provider + 'service_tier = "identity-tier"\n[agents]\ndefault_subagent_model = "identity-worker-model"\n',
    ]) {
      await localConfig(identity, local);
      const result = await projectGlobalCodexMcpForLaunch(codex, identity, argv, home);
      expect(projectedConfig(result)).toEqual(expected);
      expect(result.join(" ")).not.toContain("default_subagent_model");
      expect(result.join(" ")).not.toContain("service_tier");
      expect(await readFile(join(identity, "config.toml"), "utf8")).toBe(local);
    }
    await localConfig(identity, 'model_provider = "openai"\n');
    expect(projectedConfig(await projectGlobalCodexMcpForLaunch(codex, identity, argv, home)))
      .toEqual(parseToml(source));
  });
});
