import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

// Strip JSONC comments and trailing commas
function parseJsonc(text: string): any {
  let result = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      const start = i++;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === "\\") i++;
        i++;
      }
      result += text.slice(start, ++i);
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      i += 2;
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    result += ch;
    i++;
  }
  return JSON.parse(result.replace(/,\s*([}\]])/g, "$1"));
}

const source = parseJsonc(readFileSync("wrangler.jsonc", "utf-8"));
const generated = JSON.parse(readFileSync("dist/vite_cloud_dashboard/wrangler.json", "utf-8"));

// Bake staging overlay into the generated config
const staging = source.env?.staging;
if (!staging) {
  console.error("No env.staging found in wrangler.jsonc");
  process.exit(1);
}

const merged = { ...generated, ...staging };
delete merged.env;

const outPath = "dist/vite_cloud_dashboard/wrangler.staging.json";
writeFileSync(outPath, JSON.stringify(merged, null, 2));
console.log(`Wrote ${outPath}`);

execSync(`wrangler deploy -c ${outPath}`, { stdio: "inherit" });
