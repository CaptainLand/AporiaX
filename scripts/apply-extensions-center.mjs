import { readFile, writeFile, rm } from "node:fs/promises";

function replaceOnce(source, before, after, label) {
  const count = source.split(before).length - 1;
  if (count !== 1) throw new Error(`${label}: expected one anchor, found ${count}`);
  return source.replace(before, after);
}

let main = await readFile("src/main.jsx", "utf8");
main = replaceOnce(
  main,
  `import { SettingsPanel } from "./settings/SettingsPanel.jsx";\n`,
  `import { SettingsPanel } from "./settings/SettingsPanel.jsx";\nimport { ExtensionsSettings } from "./settings/ExtensionsSettings.jsx";\n`,
  "Extensions import",
);
main = replaceOnce(
  main,
  `  providers,\n  sandboxStatus,\n  onProvidersChanged,`,
  `  providers,\n  sandboxStatus,\n  workspacePath = "",\n  onProvidersChanged,`,
  "ApplicationSettings workspace prop",
);
main = replaceOnce(
  main,
  `            <button\n              type="button"\n              className={section === "about" ? "active" : ""}\n              onClick={() => setSection("about")}\n            >\n              <Info size={16} />\n              {tr("关于", "About")}\n            </button>`,
  `            <button\n              type="button"\n              className={section === "extensions" ? "active" : ""}\n              onClick={() => setSection("extensions")}\n            >\n              <Zap size={16} />\n              {tr("扩展与能力", "Extensions")}\n            </button>\n            <button\n              type="button"\n              className={section === "about" ? "active" : ""}\n              onClick={() => setSection("about")}\n            >\n              <Info size={16} />\n              {tr("关于", "About")}\n            </button>`,
  "Extensions settings nav",
);
main = replaceOnce(
  main,
  `            ) : section === "models" ? (\n              <ProviderManagerModal\n                embedded\n                providers={providers}\n                onClose={() => setSection("general")}\n                onChanged={onProvidersChanged}\n                onSaved={onProviderSaved}\n                onNotice={onNotice}\n              />\n            ) : (`,
  `            ) : section === "models" ? (\n              <ProviderManagerModal\n                embedded\n                providers={providers}\n                onClose={() => setSection("general")}\n                onChanged={onProvidersChanged}\n                onSaved={onProviderSaved}\n                onNotice={onNotice}\n              />\n            ) : section === "extensions" ? (\n              <ExtensionsSettings\n                workspacePath={workspacePath}\n                onNotice={onNotice}\n              />\n            ) : (`,
  "Extensions settings content",
);
main = replaceOnce(
  main,
  `          providers={providers}\n          sandboxStatus={sandboxStatus}\n          onProvidersChanged={reloadProviders}`, 
  `          providers={providers}\n          sandboxStatus={sandboxStatus}\n          workspacePath={activeTask?.workspacePath || ""}\n          onProvidersChanged={reloadProviders}`,
  "Extensions workspace invocation",
);
await writeFile("src/main.jsx", main, "utf8");

const pkg = JSON.parse(await readFile("package.json", "utf8"));
pkg.scripts["test:extensions"] = "node tests/extensions-center-smoke.mjs";
await writeFile("package.json", `${JSON.stringify(pkg, null, 2)}\n`, "utf8");

await rm("scripts/apply-extensions-center.mjs", { force: true });
await rm(".github/workflows/validate-extensions-center.yml", { force: true });
console.log("Extensions Center integration applied");
