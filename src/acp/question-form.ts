/**
 * ZCode asks a question (AskUserQuestion) with an ACP `elicitation/create` form. Its schema holds, for question i, a
 * field `q_<i>` (a string with `oneOf` choices, the last one `__skip__`) and a free-text field `q_<i>_other`.
 *
 * T3 Code renders only one shape of this form as a card with option buttons: the Factory Droid shape (`question_<n>`
 * with a `description` and `oneOf` choices `option_<k>` and `other`, a companion `question_<n>_other`, all question
 * fields required). Any other form becomes a plain text field per schema field, so every ZCode question lost its choices
 * and showed two text fields (measured 25 Nov 2026, T3 0.1.7).
 *
 * This module rewrites the ZCode form into the Droid shape and maps the answer back to the ZCode field names. A form it
 * does not recognise is left unchanged.
 */

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | undefined => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : undefined);
const text = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v : undefined);

export const SKIP_VALUE = "__skip__";

/** One question: its ZCode field id and the ZCode value of each choice, by the Droid choice id. */
export interface QuestionMap {
  zcodeId: string;
  choices: Map<string, string>;
}

/** Maps a rewritten form's answer back to the ZCode fields. */
export type FormMap = Map<string, QuestionMap>;

/** The form as T3 gets it, and the map to translate its answer. Undefined when the form is not a ZCode question form. */
export function toDroidForm(params: Json): { params: Json; map: FormMap } | undefined {
  if (params.mode !== "form") return undefined;
  const schema = obj(params.requestedSchema);
  const props = obj(schema?.properties);
  if (!props) return undefined;
  const ids = Object.keys(props).filter((k) => /^q_\d+$/.test(k));
  if (ids.length === 0 || Object.keys(props).length !== ids.length * 2) return undefined;
  const properties: Json = {};
  const required: string[] = [];
  const map: FormMap = new Map();
  let n = 0;
  for (const id of ids) {
    const field = obj(props[id]);
    if (!field || field.type !== "string" || obj(props[`${id}_other`])?.type !== "string") return undefined;
    const title = text(field.title);
    const oneOf = Array.isArray(field.oneOf) ? field.oneOf : undefined;
    if (!title || !oneOf) return undefined;
    n += 1;
    const qid = `question_${n}`;
    const choices = new Map<string, string>();
    const options: Json[] = [];
    for (const raw of oneOf) {
      const o = obj(raw);
      const value = text(o?.const);
      if (!o || value === undefined || value === SKIP_VALUE) continue;
      const choiceId = `option_${choices.size + 1}`;
      choices.set(choiceId, value);
      options.push({ const: choiceId, title: text(o.title) ?? value });
    }
    if (options.length === 0) return undefined;
    options.push({ const: "other", title: "Other" });
    properties[qid] = { type: "string", title, description: title, oneOf: options };
    properties[`${qid}_other`] = { type: "string" };
    required.push(qid);
    map.set(qid, { zcodeId: id, choices });
  }
  return { params: { ...params, requestedSchema: { ...schema, type: "object", properties, required } }, map };
}

/**
 * The client's answer to a rewritten form, with the ZCode field names. A choice gives its original value; "other" gives
 * the typed text in the `_other` field. Anything that is not an accepted answer passes unchanged.
 */
export function fromDroidAnswer(result: Json, map: FormMap): Json {
  if (result.action !== "accept") return result;
  const content = obj(result.content);
  if (!content) return result;
  const out: Json = {};
  for (const [qid, q] of map) {
    const picked = content[qid];
    if (typeof picked !== "string") continue;
    const value = q.choices.get(picked);
    if (value !== undefined) {
      out[q.zcodeId] = value;
      continue;
    }
    const typed = content[`${qid}_other`];
    if (typeof typed === "string" && typed.trim() !== "") out[`${q.zcodeId}_other`] = typed;
  }
  return { ...result, content: out };
}
