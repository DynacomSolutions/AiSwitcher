import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";

const root = new URL("../../", import.meta.url);
const read = (path: string) => readFile(new URL(path, root), "utf8");

describe("agent test gateway resolver", () => {
  it("extracts a gateway from a synthetic IPv4 default route", async () => {
    const clean = await read("image/lib/agent-exec-clean");
    const parser = clean.match(/\/usr\/bin\/awk '([^']+)'/)?.[1];
    expect(parser).toBeDefined();
    const result = spawnSync("/usr/bin/awk", [parser!], {
      encoding: "utf8",
      input: "default via 198.51.100.1 dev eth0 proto dhcp src 198.51.100.25 metric 100\n",
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("198.51.100.1\n");
  });

  it("fails closed for a default route without a gateway or with a non-address gateway", async () => {
    const clean = await read("image/lib/agent-exec-clean");
    const parser = clean.match(/\/usr\/bin\/awk '([^']+)'/)?.[1];
    expect(parser).toBeDefined();
    for (const route of [
      "default dev eth0 proto static\n",
      "default via gateway.example dev eth0 proto dhcp\n",
      "",
    ]) {
      const result = spawnSync("bash", ["-c", `gateway=$(printf '%s' "$ROUTE" | /usr/bin/awk '${parser}')\n[[ "$gateway" =~ ^[0-9.]+$ ]] || exit 126\nprintf '%s\\n' "$gateway"`], {
        encoding: "utf8",
        env: { ...process.env, ROUTE: route },
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(126);
      expect(result.stdout).toBe("");
    }
  });

  it("uses the explicit no-colour route output and the tested parser", async () => {
    const clean = await read("image/lib/agent-exec-clean");
    expect(clean).toContain("ip -color=never -4 route show default");
    expect(clean).toContain('$1 == "default"');
  });
});
