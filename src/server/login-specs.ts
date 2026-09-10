import type { ToolConfig } from "../identities/types.ts";

/** Managed login specs per tool. A tool absent from this record has no
 * daemon-managed flow and falls back to the terminal handoff in auth.ts.
 *
 * - claude: `claude auth login` renders an Ink TUI, which silently refuses
 *   to render without a TTY (verified live: zero output under plain
 *   pipes). The flow manager allocates a pseudo-terminal with util-linux
 *   `script`, surfaces the authorize URL, and injects the pasted code into
 *   the "Paste code here if prompted" stdin prompt (injection verified
 *   live). Claude's redirect URI is a remote page that displays a code,
 *   so no localhost callback is needed on the user's device.
 * - codex/grok/kimi: each ships a device-code flow (`codex login
 *   --device-auth`, `grok login --device-auth`, `kimi login`) that works
 *   under plain pipes: it prints the verification URL plus a one-time code
 *   and polls the provider itself, so no stdin injection is needed.
 * - pi has no headless login subcommand and opencode's login prompts proved
 *   non-injectable under a script PTY (verified live), so both stay on the
 *   terminal handoff. zai/ali are key/cookie writes by design.
 */
export interface LoginFlowSpec {
  args: string[];
  mode: "pty" | "pipes";
  acceptsPaste: boolean;
  /** Shown in the WebUI next to the paste box. */
  instruction?: string;
}

export const LOGIN_FLOW_SPECS: Partial<Record<ToolConfig["toolName"], LoginFlowSpec>> = {
  claude: {
    args: ["auth", "login"],
    mode: "pty",
    acceptsPaste: true,
    instruction:
      "Open the URL, sign in, and paste the code shown on the redirect page (or the full redirect URL) here.",
  },
  codex: {
    args: ["login", "--device-auth"],
    mode: "pipes",
    acceptsPaste: false,
    instruction:
      "Open the URL on any device and enter the one-time code; codex detects completion itself.",
  },
  grok: {
    args: ["login", "--device-auth"],
    mode: "pipes",
    acceptsPaste: false,
    instruction:
      "Open the URL on any device and confirm the code; grok detects completion itself.",
  },
  kimi: {
    args: ["login"],
    mode: "pipes",
    acceptsPaste: false,
    instruction:
      "Open the URL on any device and enter the one-time code; kimi detects completion itself.",
  },
};
