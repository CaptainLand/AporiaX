import { readFile, writeFile, rm } from "node:fs/promises";

const pkg = JSON.parse(await readFile("package.json", "utf8"));
pkg.scripts["test:capabilities"] = "node tests/capability-registry-smoke.mjs";
await writeFile("package.json", `${JSON.stringify(pkg, null, 2)}\n`, "utf8");

await rm("scripts/apply-capability-registry-refactor.mjs", { force: true });
await rm(".github/workflows/validate-capability-registry.yml", { force: true });
console.log("capability registry validation staged");
