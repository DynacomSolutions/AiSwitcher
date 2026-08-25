/** Bad flags/args/usage for the `ais` CLI — distinct from
 * identities/errors.ts's IdentityResolutionError family, which is about
 * resolving an identity for claude/codex, not about ais's own argv. */
export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}
