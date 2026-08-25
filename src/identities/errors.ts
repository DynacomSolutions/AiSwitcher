export class IdentityResolutionError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

export class UnknownIdentityError extends IdentityResolutionError {
  constructor(name: string, validNames: string[]) {
    super(
      "UNKNOWN_IDENTITY",
      `Unknown identity "${name}". Valid identities: ${
        validNames.length ? validNames.join(", ") : "(none configured yet)"
      }`,
    );
  }
}

export class InvalidIdentitiesFileError extends IdentityResolutionError {
  constructor(message: string) {
    super("INVALID_IDENTITIES_FILE", message);
  }
}

export class NonInteractiveResolutionError extends IdentityResolutionError {
  constructor(message: string) {
    super("NON_INTERACTIVE_RESOLUTION", message);
  }
}

export class PromptTimeoutError extends IdentityResolutionError {
  constructor(toolName: string, timeoutMs: number) {
    super(
      "PROMPT_TIMEOUT",
      `${toolName}: no identity selected within ${Math.round(timeoutMs / 1000)}s — aborting instead of hanging.`,
    );
  }
}

export class PromptCancelledError extends IdentityResolutionError {
  constructor(toolName: string) {
    super("PROMPT_CANCELLED", `${toolName}: identity selection cancelled.`);
  }
}

export class BinaryResolutionError extends Error {}
