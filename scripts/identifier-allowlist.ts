// Single reviewed allowlist for scripts/identifier-scan.ts.
//
// Everything NOT listed here is blocked by default. Add an entry only with
// a one-line justification, and prefer leaving something out (letting the
// scanner block it) over a vague or "just in case" addition.
//
// Domains are matched as an exact apex match or as a subdomain of the
// listed apex (e.g. listing "kimi.com" also allows "api.kimi.com").

export interface AllowlistEntry {
  readonly domain: string;
  readonly reason: string;
}

// RFC 2606 / RFC 6761 reserved names: guaranteed to never resolve to a real
// registration, so they are always safe as examples/fixtures/documentation.
export const RESERVED_DOMAINS: readonly AllowlistEntry[] = [
  { domain: "example.com", reason: "RFC 2606 reserved example domain" },
  { domain: "example.org", reason: "RFC 2606 reserved example domain" },
  { domain: "example.net", reason: "RFC 2606 reserved example domain" },
  { domain: "example", reason: "RFC 6761 reserved TLD" },
  { domain: "test", reason: "RFC 6761 reserved TLD" },
  { domain: "invalid", reason: "RFC 6761 reserved TLD" },
  { domain: "localhost", reason: "RFC 6761 reserved name, always loopback" },
];

// Genuine third-party public domains the code calls, or a fixed reference it
// needs, to function. Enumerated from the actual source: every entry below
// has at least one call site or normative reference in this repository.
export const VENDOR_DOMAINS: readonly AllowlistEntry[] = [
  { domain: "github.com", reason: "release asset URLs and repo links (src/shared/release-assets.ts)" },
  { domain: "npmjs.org", reason: "npm registry version check (src/cli/upgrade.ts)" },
  { domain: "googleapis.com", reason: "Grok CLI's public build-artifact bucket (src/cli/upgrade.ts)" },
  { domain: "kimi.com", reason: "Kimi provider API and OAuth (src/cli/limits/kimi-limits.ts, src/identities/oauth-refresh.ts)" },
  { domain: "chatgpt.com", reason: "Codex/OpenAI auth and rate-limit endpoint (src/cli/limits/codex-limits.ts, http.ts)" },
  { domain: "openai.com", reason: "OpenAI OAuth token endpoint (src/identities/oauth-refresh.ts)" },
  { domain: "claude.com", reason: "Anthropic platform/OAuth endpoint (src/identities/oauth-refresh.ts)" },
  { domain: "claude.ai", reason: "Anthropic's consumer product, referenced when distinguishing plan types (src/cli/limits/claude-limits.ts)" },
  { domain: "anthropic.com", reason: "Anthropic API: GET /api/oauth/usage for claude swap pool limits (src/identities/claude-usage-api.ts), plus OAuth context in src/identities/oauth-refresh.ts" },
  { domain: "alibabacloud.com", reason: "Alibaba Cloud console/auth domains (src/identities/auth-session.ts, ali-limits.ts)" },
  { domain: "aliyun.com", reason: "Alibaba Cloud auth cookie domain (src/identities/auth-session.ts)" },
  { domain: "aliyuncs.com", reason: "Alibaba MaaS token-plan API (src/identities/ali-auth.ts, tool-configs.ts)" },
  { domain: "x.ai", reason: "xAI (Grok) OAuth and installer domains (src/cli/upgrade.ts, oauth-refresh.ts)" },
  { domain: "z.ai", reason: "Zai provider API and docs (src/identities/zai-auth.ts, src/cli/limits/zai-limits.ts)" },
  { domain: "opencode.ai", reason: "OpenCode provider usage API (src/cli/limits/opencode-limits.ts)" },
  { domain: "models.dev", reason: "public model pricing/catalogue data source (src/identities/model-pricing.ts)" },
  { domain: "no-color.org", reason: "NO_COLOR convention this CLI implements, cited in a comment (src/cli/colors.ts)" },
  { domain: "k8s.io", reason: "official Kubernetes release download used by the image build (Dockerfile)" },
  { domain: "kubernetes.io", reason: "well-known Kubernetes label-key namespace, e.g. kubernetes.io/hostname (k8s/deployment.yaml)" },
  { domain: "getambassador.io", reason: "Emissary-ingress Mapping API group used in apiVersion fields (k8s/*.yaml)" },
  { domain: "w3.org", reason: "SVG namespace URI required by the SVG spec, not a network endpoint (apps/web/index.html)" },
  { domain: "bigmodel.cn", reason: "Zhipu/Z.ai China-region API endpoint, alongside the global z.ai endpoint (AGENTS.md)" },
];

// Not a domain/hostname (no TLD-shaped last label), so the scanner never
// flags it, but noted here for audit purposes since it names this
// repository's own owning organisation: src/shared/release-assets.ts's
// `REPO = "DynacomSolutions/AiSwitcher"` constant is this repo's own public
// github.com/<owner>/<repo> path, required for every release download
// (installer, `ais update`, the aistui self-heal) and already public since
// this file lives in that repo. Scoped to exactly that path; not a general
// exemption for the owning organisation's name elsewhere.

export const ALLOWED_DOMAINS: readonly AllowlistEntry[] = [...RESERVED_DOMAINS, ...VENDOR_DOMAINS];

// File-extension-shaped tokens that must never be treated as a TLD, because
// this repository's own source tree is full of them (import paths, doc
// references to other files, etc). Some of these ARE real ccTLDs/gTLDs
// (.ts = Trinidad & Tobago, .rs = Serbia) which is exactly why they would
// otherwise cause a flood of false positives on ordinary file references
// like "guard.ts" or "app.rs".
export const EXCLUDED_TLDS: ReadonlySet<string> = new Set([
  "ts", "tsx", "js", "jsx", "rs", "md", "json", "yaml", "yml", "toml",
  "lock", "sh", "py", "go", "rb", "css", "html", "svg", "png", "txt",
  "db", "gz", "jsonl", "wasm",
  "app", // macOS .app bundle paths (/Applications/Codex.app), not a TLD in use here
  // These four ARE real gTLDs/ccTLDs (.name, .id = Indonesia, .at = Austria,
  // .info) but no vendor this project talks to uses one, and they are also
  // extremely common object-property/field names (`x.name`, `event.id`,
  // `array.at(i)`, `console.log(...).info`), so treating them as a TLD here
  // produces far more code-chain false positives than it ever catches.
  "name", "id", "at", "info",
  "email", // real gTLD, but also the `user.email`/`git config user.email` key literally used here
]);
