import type { AddGatewayIdentityBody } from "../types/api";

/** Tools the console can add a login slot for through the gateway store. */
export const GATEWAY_IDENTITY_TOOLS = ["claude", "codex"] as const;

/** Same grammar the server holds names to: lowercase letters, digits and single hyphens. */
export const IDENTITY_NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function canAddGatewayIdentity(tool: string): boolean {
  return (GATEWAY_IDENTITY_TOOLS as readonly string[]).includes(tool);
}

export interface AddIdentityFormInput {
  name: string;
  label: string;
  description: string;
  /** Pool name, or "" for none. */
  pool: string;
}

/** A short reason the form cannot be sent yet, or undefined when it can. */
export function addIdentityProblem(input: AddIdentityFormInput, taken: readonly string[]): string | undefined {
  const name = input.name.trim();
  if (!name) return "Enter a name.";
  if (!IDENTITY_NAME_PATTERN.test(name)) return "Use lowercase letters, digits and single hyphens only, for example identity-a.";
  if (taken.includes(name)) return `"${name}" is already in use.`;
  return undefined;
}

/** The request body: trimmed text, empty optional fields left out. */
export function addIdentityBody(input: AddIdentityFormInput): AddGatewayIdentityBody {
  const name = input.name.trim();
  const description = input.description.trim();
  return {
    name,
    label: input.label.trim() || name,
    ...(description ? { description } : {}),
    ...(input.pool ? { pool: input.pool } : {}),
  };
}
