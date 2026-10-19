import { expect, test } from "bun:test";
import { modelPath, readFilter, withFilter } from "../../apps/web/src/lib/local-models-url";

test("modelPath puts the model in the path segment and encodes it", () => {
  expect(modelPath()).toBe("/local-models");
  expect(modelPath("tiny")).toBe("/local-models/tiny");
  expect(modelPath("a b/c")).toBe("/local-models/a%20b%2Fc");
});
test("withFilter sets q, drops it when empty and keeps other keys", () => {
  expect(withFilter(new URLSearchParams("x=1"), "ti").toString()).toBe("x=1&q=ti");
  expect(withFilter(new URLSearchParams("q=ti&x=1"), "").toString()).toBe("x=1");
});
test("readFilter defaults to the empty string", () => {
  expect(readFilter(new URLSearchParams(""))).toBe("");
  expect(readFilter(new URLSearchParams("q=ti"))).toBe("ti");
});
