import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// The host app resets persist by zeroing LUKS_HEADER_BYTES (apps/host/crates/core/src/device.rs).
test("persist formatting pins LUKS2 geometry inside the first 16 MiB", () => {
  const hook = readFileSync("image/archiso/airootfs/etc/initcpio/hooks/ais_persist", "utf8");
  const format = hook.split("\n").find((line) => line.includes("cryptsetup luksFormat"));
  expect(format).toBeDefined();
  const sectors = Number(format!.match(/--offset (\d+)/)?.[1]);
  const metadata = format!.match(/--luks2-metadata-size (\d+)k/);
  const keyslots = Number(format!.match(/--luks2-keyslots-size (\d+)/)?.[1]);
  expect(sectors * 512).toBe(16 * 1024 * 1024);
  expect(2 * Number(metadata?.[1]) * 1024 + keyslots).toBe(sectors * 512);
  const device = readFileSync("apps/host/crates/core/src/device.rs", "utf8");
  expect(device).toContain("pub const LUKS_HEADER_BYTES: u64 = 16 * 1024 * 1024;");
});
