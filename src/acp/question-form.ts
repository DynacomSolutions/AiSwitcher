/**
 * ZCode asks a question (AskUserQuestion) with an ACP `elicitation/create` form. Its schema holds, for question i, a
 * field `q_<i>` (a string with `oneOf` choices, the last one `__skip__`) and a free-text field `q_<i>_other`.
 *
 * T3 Code (0.1.7, measured in its binary) reads such a form on its generic path for an agent that is not a registry
 * agent: a card per schema field, the question from `description`, and option buttons only from `enum` values (the
 * button label is the value; `oneOf` and `enumNames` are ignored). Its Factory Droid card is used only when the agent is
 * the registry agent `factory-droid`. A form with no `enum` shows free text and the choices are lost. The answer is the
 * clicked value or typed text under the field key; keys that are not schema fields are dropped.
 *
 * This module rewrites each ZCode question into `q_<i>: {type: string, title, description, enum}` and maps the answer
 * back: a value in the enum goes to `q_<i>` as the original value, any other text goes to `q_<i>_other`. The skip choice
 * stays as an option, and no field is required, so one blank answer never cancels the form. A form it does not
 * recognise is left unchanged.
 */

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | undefined => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : undefined);
const text = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v : undefined);

export const SKIP_VALUE = "__skip__";

/** One question: its ZCode field id and the ZCode value of each button label. */
export interface QuestionMap {
  zcodeId: string;
  choices: Map<string, string>;
}

/** Maps a rewritten form's answer back to the ZCode fields, by field id. */
export type FormMap = Map<string, QuestionMap>;

/** The form as T3 gets it, and the map to translate its answer. Undefined when the form is not a ZCode question form. */
export function toButtonForm(params: Json): { params: Json; map: FormMap } | undefined {
  if (params.mode !== "form") return undefined;
  const schema = obj(params.requestedSchema);
  const props = obj(schema?.properties);
  if (!props) return undefined;
  const ids = Object.keys(props).filter((k) => /^q_\d+$/.test(k));
  if (ids.length === 0 || Object.keys(props).length !== ids.length * 2) return undefined;
  const properties: Json = {};
  const map: FormMap = new Map();
  for (const id of ids) {
    const field = obj(props[id]);
    if (!field || field.type !== "string" || obj(props[`${id}_other`])?.type !== "string") return undefined;
    const title = text(field.title);
    const oneOf = Array.isArray(field.oneOf) ? field.oneOf : undefined;
    if (!title || !oneOf) return undefined;
    const choices = new Map<string, string>();
    for (const raw of oneOf) {
      const o = obj(raw);
      const value = text(o?.const);
      if (!o || value === undefined) continue;
      let label = text(o.title) ?? value;
      for (let n = 2; choices.has(label); n += 1) label = `${text(o.title) ?? value} (${n})`;
      choices.set(label, value);
    }
    if ([...choices.values()].every((v) => v === SKIP_VALUE)) return undefined;
    properties[id] = { type: "string", title, description: title, enum: [...choices.keys()] };
    map.set(id, { zcodeId: id, choices });
  }
  return { params: { ...params, requestedSchema: { ...schema, type: "object", properties, required: [] } }, map };
}

/**
 * The client's answer to a rewritten form, with the ZCode field names. A button gives its original value; other text
 * gives the typed text in the `_other` field. Anything that is not an accepted answer passes unchanged.
 */
export function fromButtonAnswer(result: Json, map: FormMap): Json {
  if (result.action !== "accept") return result;
  const content = obj(result.content);
  if (!content) return result;
  const out: Json = {};
  for (const [qid, q] of map) {
    const picked = content[qid];
    if (typeof picked !== "string" || picked.trim() === "") continue;
    const value = q.choices.get(picked);
    if (value !== undefined) out[q.zcodeId] = value;
    else out[`${q.zcodeId}_other`] = picked;
  }
  return { ...result, content: out };
}
