import { SelectPrompt, wrapTextWithPrefix } from "@clack/core";
import * as clack from "@clack/prompts";
import { styleText } from "node:util";
import { copyToClipboard } from "./clipboard.ts";
import {
  BRANCH,
  BRANCH_LAST,
  DETAIL_INDENT,
  DETAIL_INDENT_LAST,
  formatSessionColumns,
  groupByToolAndIdentity,
  identityCount,
  labelColumnWidth,
  timeColumnWidth,
} from "./report.ts";
import type { ResumableSession, ToolResumeResult } from "./types.ts";

/** A header row (tool or identity) has no session behind it — `disabled:
 * true` is the load-bearing bit: @clack/prompts' select() skips disabled
 * options during ALL cursor movement (confirmed by reading its own findCursor
 * logic) and renders them as plain gray text with no strikethrough, unlike
 * its multiselect checkbox rendering — exactly what a plain section header
 * needs, with zero custom TUI code of our own. The cursor can therefore only
 * ever land on, and Enter can only ever confirm, an actual session. */
type PickOption = { value: ResumableSession | null; label: string; disabled?: boolean };

/** Builds the exact same tool -> identity -> session tree formatResumeTree
 * prints (see report.ts's groupByToolAndIdentity), as a flat option list:
 * a header option per tool and per identity, disabled so they're skipped
 * over, plus one real, selectable option per session — each one's label
 * already ending in the same dim "last active  session-id" columns the
 * static tree shows (see formatSessionColumns), so `c` has something to
 * copy and a user has something to read even before pressing it. */
export function buildPickOptions(results: ToolResumeResult[], now: Date = new Date()): PickOption[] {
  const groups = groupByToolAndIdentity(results);
  const width = labelColumnWidth(groups);
  const timeWidth = timeColumnWidth(groups, now);
  const options: PickOption[] = [];

  for (const group of groups) {
    options.push({ value: null, disabled: true, label: `${group.toolName} (${identityCount(group.identityGroups.length)})` });

    group.identityGroups.forEach((ig, ii) => {
      const isLast = ii === group.identityGroups.length - 1;
      options.push({
        value: null,
        disabled: true,
        label: `${isLast ? BRANCH_LAST : BRANCH}${ig.identity.name}  (${ig.identity.label})`,
      });

      const indent = isLast ? DETAIL_INDENT_LAST : DETAIL_INDENT;
      for (const s of ig.sessions) {
        options.push({ value: s, label: `${indent}${formatSessionColumns(s, width, timeWidth, now)}` });
      }
    });
  }

  return options;
}

const INSTRUCTIONS = [
  ...clack.SELECT_INSTRUCTIONS,
  `${styleText("dim", "c:")} copy session id`,
];

function renderOption(item: PickOption, mode: "disabled" | "selected" | "active" | "cancelled" | "inactive"): string {
  const label = item.label;
  switch (mode) {
    case "disabled":
      return `${styleText("gray", clack.S_RADIO_INACTIVE)} ${styleText("gray", label)}`;
    case "selected":
      return styleText("dim", label);
    case "active":
      return `${styleText("green", clack.S_RADIO_ACTIVE)} ${label}`;
    case "cancelled":
      return styleText(["strikethrough", "dim"], label);
    default:
      return `${styleText("dim", clack.S_RADIO_INACTIVE)} ${styleText("dim", label)}`;
  }
}

/**
 * A hand-built select prompt, not @clack/prompts' own sealed `select()`:
 * that function creates its SelectPrompt instance internally and never
 * hands it back, so there's no way to attach the extra "c" key listener a
 * copy-to-clipboard shortcut needs from outside it. Built instead directly
 * on @clack/core's exported SelectPrompt/wrapTextWithPrefix plus
 * @clack/prompts' own exported rendering primitives (symbol/symbolBar/
 * S_RADIO_ACTIVE/S_RADIO_INACTIVE/SELECT_INSTRUCTIONS/formatInstructionFooter/
 * limitOptions) — the same public building blocks `select()` itself is
 * written from (confirmed by reading its actual source), so this renders
 * identically to every other prompt in this codebase rather than being a
 * one-off, drifting reimplementation.
 *
 * Pressing "c" copies the currently-highlighted session's id (never a
 * header — the cursor can't land on one) without submitting the prompt,
 * showing a transient "(copied)" note next to that row; moving the cursor
 * clears the note, since it's about "you just copied THIS one." Copy is
 * fire-and-forget (see clipboard.ts) — optimistic UI, since a real desktop
 * clipboard tool essentially never fails once found.
 */
function selectWithCopyShortcut(message: string, options: PickOption[]): Promise<ResumableSession | null | symbol> {
  let copiedValue: ResumableSession | null = null;

  const prompt = new SelectPrompt<PickOption>({
    options,
    render(this: SelectPrompt<PickOption>) {
      const withGuide = clack.settings.withGuide;
      const messageBlock = wrapTextWithPrefix(process.stdout, message, `${clack.symbolBar(this.state)}  `, `${clack.symbol(this.state)}  `);
      const header = `${withGuide ? `${styleText("gray", clack.S_BAR)}\n` : ""}${messageBlock}\n`;

      if (this.state === "submit") {
        const prefix = withGuide ? `${styleText("gray", clack.S_BAR)}  ` : "";
        return `${header}${wrapTextWithPrefix(process.stdout, renderOption(this.options[this.cursor]!, "selected"), prefix)}`;
      }
      if (this.state === "cancel") {
        const prefix = withGuide ? `${styleText("gray", clack.S_BAR)}  ` : "";
        const body = wrapTextWithPrefix(process.stdout, renderOption(this.options[this.cursor]!, "cancelled"), prefix);
        return `${header}${body}${withGuide ? `\n${styleText("gray", clack.S_BAR)}` : ""}`;
      }

      const prefix = withGuide ? `${styleText("cyan", clack.S_BAR)}  ` : "";
      const headerLineCount = header.split("\n").length;
      const footerLines = clack.formatInstructionFooter(INSTRUCTIONS, withGuide);
      const footerLineCount = footerLines.length + 1;
      const active = this.options[this.cursor]!;
      const body = clack
        .limitOptions({
          output: process.stdout,
          cursor: this.cursor,
          options: this.options,
          columnPadding: prefix.length,
          rowPadding: headerLineCount + footerLineCount,
          style: (opt, isActive) => {
            const rendered = renderOption(opt, opt.disabled ? "disabled" : isActive ? "active" : "inactive");
            return isActive && opt.value === copiedValue ? `${rendered}  ${styleText("green", "(copied)")}` : rendered;
          },
        })
        .join(`\n${prefix}`);
      return `${header}${prefix}${body}\n${footerLines.join("\n")}\n`;
    },
  });

  prompt.on("cursor", () => {
    copiedValue = null;
  });
  prompt.on("key", (_char, key) => {
    if (key?.name !== "c" || key.ctrl || key.meta) return;
    const active = prompt.options[prompt.cursor];
    if (!active || active.disabled || !active.value) return;
    copiedValue = active.value;
    void copyToClipboard(active.value.sessionId);
  });

  return prompt.prompt() as Promise<ResumableSession | null | symbol>;
}

/**
 * Interactive tree picker: navigate with arrow keys (landing only on actual
 * sessions, never a tool/identity header), press Enter to choose one to
 * resume, or "c" to copy the highlighted session's id to the clipboard
 * without resuming it. No labels are pre-colored with colors.ts here (unlike
 * formatResumeTree's static print) — every session's own dim "last
 * active/id" columns already carry ANSI codes from formatSessionColumns,
 * and clack's own per-row styling nests around them cleanly (confirmed:
 * inactive/disabled rows re-wrap the whole line in a single outer style,
 * which is harmless to re-apply over already-dim text; the active row
 * applies no outer style to the label at all, so the embedded dim bits
 * stay visibly duller than the un-wrapped title next to them).
 *
 * Returns undefined if there was nothing to pick from, or if the user
 * cancelled (Ctrl+C) — both are normal, silent outcomes here, not errors:
 * unlike identities/prompt.ts's picker (which MUST resolve an identity for
 * its caller to proceed at all), browsing resume candidates without picking
 * one is a completely valid thing to do.
 */
export async function pickSessionInteractively(
  results: ToolResumeResult[],
  now: Date = new Date(),
): Promise<ResumableSession | undefined> {
  const options = buildPickOptions(results, now);
  if (!options.some((o) => o.value !== null)) return undefined;

  clack.intro("ais resume");
  const chosen = await selectWithCopyShortcut("Select a session to resume", options);

  if (clack.isCancel(chosen) || chosen === null) {
    clack.cancel("Nothing resumed.");
    return undefined;
  }

  clack.outro(`Resuming: ${chosen.label}`);
  return chosen;
}
