import fs from "node:fs";

const directory = process.argv[2];
if (!directory) throw new Error("usage: exchange-highest-outbox.mjs <directory>");

let names;
try {
  names = fs.readdirSync(directory);
} catch (error) {
  if (error?.code === "ENOENT") {
    process.stdout.write("0\n");
    process.exit(0);
  }
  throw error;
}

let highest = 0;
for (const name of names) {
  const match = /^bundle-([1-9][0-9]{0,17})\.age$/.exec(name);
  if (match && Number.isSafeInteger(Number(match[1]))) highest = Math.max(highest, Number(match[1]));
}
process.stdout.write(`${highest}\n`);
