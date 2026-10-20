import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { checkLine, isPythonShebang } from "../../scripts/identifier-scan.ts";

const profile = "image/archiso";
const packages = readFileSync(`${profile}/packages.x86_64`, "utf8")
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith("#"));
const profiledef = readFileSync(`${profile}/profiledef.sh`, "utf8");

describe("packages.x86_64", () => {
  test("has the required set", () => {
    for (const p of ["base", "linux", "mkinitcpio-archiso", "syslinux", "cryptsetup", "gptfdisk", "util-linux", "btrfs-progs", "exfatprogs", "age", "networkmanager", "sudo", "nodejs", "npm"]) {
      expect(packages).toContain(p);
    }
  });
  test("has no preinstalled disk or rescue tooling", () => {
    for (const p of ["gparted", "clonezilla", "testdisk", "ddrescue"]) expect(packages).not.toContain(p);
  });
  test("rsync is present only because ais sync needs it", () => {
    expect(packages).toContain("rsync");
  });
  test("qemu-guest-agent is not required", () => {
    expect(packages).not.toContain("qemu-guest-agent");
  });
});

describe("profiledef.sh", () => {
  test("lists both boot modes", () => {
    expect(profiledef).toContain("'bios.syslinux'");
    expect(profiledef).toContain("'uefi.grub'");
  });
  test("derives from baseline: no releng package group", () => {
    for (const p of ["cloud-init", "hyperv", "open-vm-tools", "virtualbox-guest-utils-nox", "memtest86+", "mtools", "nmap", "tcpdump"]) {
      expect(packages).not.toContain(p);
    }
    expect(profiledef).toContain("baseline");
  });
});

describe("herdr licence", () => {
  const dir = `${profile}/airootfs/usr/share/licenses/herdr`;
  test("licence text and source link ship in the image", () => {
    expect(statSync(`${dir}/LICENSE`).size).toBeGreaterThan(1000);
    expect(readFileSync(`${dir}/SOURCE`, "utf8")).toMatch(/https:\/\/github\.com\/herdrdev\/herdr/);
  });
});

function files(dir: string): string[] {
  // Symlinks (the guard wrapper directory) point at absolute guest paths.
  return readdirSync(dir, { withFileTypes: true }).filter((e) => !e.isSymbolicLink()).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]));
}

test("no line under image/ trips the identifier scan", () => {
  const hits: string[] = [];
  for (const f of files("image")) {
    const lines = readFileSync(f, "utf8").split("\n");
    const state = { inBlock: false, python: isPythonShebang(lines[0] ?? "") };
    lines.forEach((line, i) => {
      for (const rule of checkLine(f, line, state)) hits.push(`${f}:${i + 1} ${rule}`);
    });
  }
  expect(hits).toEqual([]);
});
