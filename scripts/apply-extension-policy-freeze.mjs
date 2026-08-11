import { access, readFile, writeFile, rm } from "node:fs/promises";

function once(source, before, after, label) {
  const count = source.split(before).length - 1;
  if (count !== 1) throw new Error(`${label}: expected one anchor, found ${count}`);
  return source.replace(before, after);
}

let runtime = await readFile("electron/agent-runtime-core.js", "utf8");
runtime = once(
  runtime,
  `  mcpConfigErrors = [],\n  capabilityRegistry = null,\n}) {`,
  `  mcpConfigErrors = [],\n  capabilityRegistry = null,\n  extensionPolicy = {},\n}) {`,
  "extension policy run parameter",
);
runtime = once(
  runtime,
  `  const browserRuntime = createBrowserRuntime();\n  witness = createWitnessMonitor({ emit: forwardEvent });`,
  `  const browserEnabled = extensionPolicy?.browser !== false;\n  const browserRuntime = createBrowserRuntime();\n  witness = createWitnessMonitor({ emit: forwardEvent });`,
  "browser policy state",
);
runtime = once(
  runtime,
  `  const staticToolCatalog = hasWorkspace\n    ? projectNativeToolCatalog({\n        catalog: TOOL_REGISTRY.catalog(permissionPolicy),\n        approvalMode: effectiveApprovalMode,\n        sandboxStatus,\n      })\n    : [];`,
  `  const staticToolCatalog = hasWorkspace\n    ? projectNativeToolCatalog({\n        catalog: TOOL_REGISTRY.catalog(permissionPolicy),\n        approvalMode: effectiveApprovalMode,\n        sandboxStatus,\n      }).filter((tool) => browserEnabled || !String(tool.name || "").startsWith("browser_"))\n    : [];`,
  "browser tool catalog policy",
);
runtime = once(
  runtime,
  `  const staticToolDefinitions = hasWorkspace\n    ? TOOL_REGISTRY.definitions(permissionPolicy).filter(\n        (definition) =>\n          definition.function.name !== "run_command" || commandToolAvailable,\n      )\n    : [];`,
  `  const staticToolDefinitions = hasWorkspace\n    ? TOOL_REGISTRY.definitions(permissionPolicy).filter((definition) => {\n        const name = definition.function.name;\n        if (!browserEnabled && String(name || "").startsWith("browser_")) return false;\n        return name !== "run_command" || commandToolAvailable;\n      })\n    : [];`,
  "browser definition policy",
);
runtime = once(
  runtime,
  `    mcpErrors: mcpDiscovery.errors || [],\n  });`,
  `    mcpErrors: mcpDiscovery.errors || [],\n    extensionPolicy: { ...extensionPolicy },\n  });`,
  "turn policy observability",
);
runtime = once(
  runtime,
  `        "Use browser_open and browser_snapshot when the task requires checking a running web page. Prefer semantic browser locators. Treat browser_click, browser_fill, and browser_press as potentially state-changing actions and never claim a page was verified without observing the resulting snapshot, console, or network evidence.",`,
  `        browserEnabled\n          ? "Use browser_open and browser_snapshot when the task requires checking a running web page. Prefer semantic browser locators. Treat browser_click, browser_fill, and browser_press as potentially state-changing actions and never claim a page was verified without observing the resulting snapshot, console, or network evidence."\n          : "Browser capabilities are disabled by the effective Extension Policy for this task. Do not claim browser verification was performed.",`,
  "browser prompt policy",
);
await writeFile("electron/agent-runtime-core.js", runtime, "utf8");

let pkg = JSON.parse(await readFile("package.json", "utf8"));
pkg.scripts["test:extension-policy"] = "node tests/extension-policy-smoke.mjs";
pkg.scripts["test:v06-architecture"] = "node tests/v06-architecture-freeze-smoke.mjs";
await writeFile("package.json", `${JSON.stringify(pkg, null, 2)}\n`, "utf8");

await rm("scripts/apply-extension-policy-freeze.mjs", { force: true });
await rm(".github/workflows/validate-extension-policy-freeze.yml", { force: true });
console.log("extension policy + architecture freeze migration applied");
