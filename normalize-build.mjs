import { readdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("./", import.meta.url)).replace(/\/$/u, "");

for (const entry of await readdir(new URL("./lib/", import.meta.url), { withFileTypes: true })) {
  if (!entry.isFile() || !/\.js(?:\.map)?$/u.test(entry.name)) continue;
  const file = new URL(`./lib/${entry.name}`, import.meta.url);
  const source = await readFile(file, "utf8");
  await writeFile(file, source
    .split(packageRoot).join(".")
    .replace(/[ \t]+$/gm, ""));
}
