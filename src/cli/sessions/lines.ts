import { fileTextChunks } from "../../shared/local-spend.ts";

/**
 * Line sources for the session readers and indexers.
 *
 * A reader takes a `LineSource`: a file path (read through `fileLines`) or any
 * (async) iterable of lines. Each line holds no "\n". Later code feeds the
 * readers lines from decrypted object parts through the same functions.
 * A source is read once. A reader that needs two answers from one file
 * folds them into one pass.
 */
export type LineSource = string | AsyncIterable<string> | Iterable<string>;

/**
 * File adapter: streams a text file LINE BY LINE without holding the whole
 * file in memory. fileTextChunks (shared with the usage pipeline) yields
 * bounded decoded pieces. A real macrotask yield follows each piece (the #63
 * lesson: awaiting the stream alone runs whole-file stretches inside
 * microtasks). Lines come in file order. A final partial line (no trailing
 * newline, torn write) is still yielded. A trailing "\n" adds no empty line.
 */
export async function* fileLines(path: string): AsyncGenerator<string, void, undefined> {
  let rest = "";
  for await (const chunk of fileTextChunks(path)) {
    rest += chunk;
    let newlineAt = rest.indexOf("\n");
    while (newlineAt !== -1) {
      yield rest.slice(0, newlineAt);
      rest = rest.slice(newlineAt + 1);
      newlineAt = rest.indexOf("\n");
    }
    await Bun.sleep(0);
  }
  if (rest) yield rest;
}

/** The lines of any source: a path goes through the file adapter. */
export function linesOf(source: LineSource): AsyncIterable<string> | Iterable<string> {
  return typeof source === "string" ? fileLines(source) : source;
}

/** Calls `visit` once per line, in order. */
export async function forEachLine(source: LineSource, visit: (line: string) => void): Promise<void> {
  for await (const line of linesOf(source)) visit(line);
}

/**
 * Bounded prefix read: returns the first line that satisfies `predicate`
 * (or undefined when nothing matches). The match is nearly always within the
 * first few lines, so the rest of a multi-megabyte transcript is never
 * touched: the iteration stops (and a file stream is released) at the match.
 */
export async function findFirstLine(
  source: LineSource,
  predicate: (line: string) => boolean,
): Promise<string | undefined> {
  for await (const line of linesOf(source)) {
    if (predicate(line)) return line;
  }
  return undefined;
}

/** Splits text into the lines `fileLines` would yield for a file with that text. */
export function* linesOfText(text: string): Generator<string, void, undefined> {
  let start = 0;
  let newlineAt = text.indexOf("\n", start);
  while (newlineAt !== -1) {
    yield text.slice(start, newlineAt);
    start = newlineAt + 1;
    newlineAt = text.indexOf("\n", start);
  }
  if (start < text.length) yield text.slice(start);
}
