import { expect, test } from "bun:test";
import { displayIdentity } from "../src/content/indicator.ts";

test("pill shows the pool name for pool sessions and the identity otherwise", () => {
  expect(displayIdentity("pool:main")).toBe("main");
  expect(displayIdentity("dyn")).toBe("dyn");
});
