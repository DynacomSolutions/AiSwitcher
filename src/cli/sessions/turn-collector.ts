import { clampText, DEFAULT_TAIL_TURNS } from "./shared.ts";
import type { TranscriptTurnDto } from "./types.ts";

/**
 * Tail-weighted turn accumulator shared by every per-tool transcript
 * reader: keeps at most `tail` turns (newest wins), counts every
 * normalized turn (totalTurns includes dropped ones), and remembers tool
 * turns awaiting their result so a later matching result line fills the
 * SAME turn object in place (works even after front-trimming, since the
 * map holds object references, not indexes). A tool call whose result never
 * arrives (still running, or torn write) keeps its empty text: the correct
 * live representation of an in-flight call.
 */
export class TurnCollector {
  readonly turns: TranscriptTurnDto[] = [];
  total = 0;

  private readonly tail: number;
  private readonly pending = new Map<string, TranscriptTurnDto>();

  constructor(tail: number = DEFAULT_TAIL_TURNS) {
    this.tail = Math.max(1, tail);
  }

  get truncated(): boolean {
    return this.total > this.turns.length;
  }

  push(turn: TranscriptTurnDto): void {
    this.total += 1;
    this.turns.push(turn);
    if (this.turns.length > this.tail) this.turns.shift();
  }

  /** Registers a tool turn as awaiting its result under `callId`. */
  track(callId: string, turn: TranscriptTurnDto): void {
    this.pending.set(callId, turn);
  }

  /** Fills the tracked tool turn's result text (clamped again at fill time:
   * results are the fattest part of any transcript). Unknown callIds are
   * ignored (results for calls outside the window). */
  fill(callId: string, text: string): void {
    const turn = this.pending.get(callId);
    if (!turn) return;
    turn.text = clampText(text);
    this.pending.delete(callId);
  }
}
