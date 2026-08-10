import { readFile, writeFile, rm } from "node:fs/promises";

async function patchFile(path, transforms) {
  let source = await readFile(path, "utf8");
  for (const { before, after, label } of transforms) {
    const count = source.split(before).length - 1;
    if (count !== 1) {
      throw new Error(`${path}: expected one ${label} anchor, found ${count}`);
    }
    source = source.replace(before, after);
  }
  await writeFile(path, source, "utf8");
}

await patchFile("electron/agent-runtime-core.js", [
  {
    label: "browser import",
    before: `import { createWitnessMonitor } from "./witness-monitor.js";\n`,
    after: `import { createWitnessMonitor } from "./witness-monitor.js";\nimport {\n  BROWSER_TOOL_DEFINITIONS,\n  BROWSER_TOOL_RISKS,\n  createBrowserRuntime,\n  executeBrowserTool,\n  isBrowserToolName,\n} from "./browser-runtime.js";\n`,
  },
  {
    label: "browser definitions",
    before: `  ...OFFICE_TOOL_DEFINITIONS,\n  {\n    type: "function",\n    function: {\n      name: "complete_self_check",`,
    after: `  ...OFFICE_TOOL_DEFINITIONS,\n  ...BROWSER_TOOL_DEFINITIONS,\n  {\n    type: "function",\n    function: {\n      name: "complete_self_check",`,
  },
  {
    label: "browser risks",
    before: `  run_command: "execute",\n  complete_self_check: "control",\n};`,
    after: `  run_command: "execute",\n  ...BROWSER_TOOL_RISKS,\n  complete_self_check: "control",\n};`,
  },
  {
    label: "executeTool browser parameter",
    before: `  sandboxExecutor = runCommandWithFallback,\n  sandboxStatus = null,\n}) {`,
    after: `  sandboxExecutor = runCommandWithFallback,\n  sandboxStatus = null,\n  browserRuntime = null,\n}) {`,
  },
  {
    label: "browser execution",
    before: `  if (toolName === "list_directory") {`,
    after: `  if (isBrowserToolName(toolName)) {\n    return {\n      modelResult: await executeBrowserTool(browserRuntime, toolName, input),\n    };\n  }\n\n  if (toolName === "list_directory") {`,
  },
  {
    label: "browser runtime creation",
    before: `  witness = createWitnessMonitor({ emit: forwardEvent });\n  emit({`,
    after: `  const browserRuntime = createBrowserRuntime();\n  witness = createWitnessMonitor({ emit: forwardEvent });\n  emit({`,
  },
  {
    label: "browser prompt guidance",
    before: `        "Use git_status and git_diff to inspect repository changes when the workspace is a Git repository.",\n`,
    after: `        "Use git_status and git_diff to inspect repository changes when the workspace is a Git repository.",\n        "Use browser_open and browser_snapshot when the task requires checking a running web page. Prefer semantic browser locators. Treat browser_click, browser_fill, and browser_press as potentially state-changing actions and never claim a page was verified without observing the resulting snapshot, console, or network evidence.",\n`,
  },
  {
    label: "main executeTool browser runtime",
    before: `              sandboxExecutor,\n              sandboxStatus,\n            });\n            if (result.change) {`,
    after: `              sandboxExecutor,\n              sandboxStatus,\n              browserRuntime,\n            });\n            if (result.change) {`,
  },
  {
    label: "browser teardown",
    before: `  } finally {\n    witness?.dispose();\n  }\n}\n\nexport async function listWorkspaceTree`,
    after: `  } finally {\n    await browserRuntime.close().catch(() => undefined);\n    witness?.dispose();\n  }\n}\n\nexport async function listWorkspaceTree`,
  },
]);

await patchFile("src/main.jsx", [
  {
    label: "browser live labels",
    before: `      run_command: tr("正在准备验证命令", "Preparing verification command"),\n      update_plan: tr("正在更新执行计划", "Updating the execution plan"),`,
    after: `      run_command: tr("正在准备验证命令", "Preparing verification command"),\n      browser_open: tr("正在打开浏览器页面", "Opening browser page"),\n      browser_snapshot: tr("正在观察页面结构", "Inspecting page structure"),\n      browser_click: tr("正在点击页面元素", "Clicking page element"),\n      browser_fill: tr("正在填写页面内容", "Filling page input"),\n      browser_press: tr("正在发送键盘操作", "Sending keyboard input"),\n      browser_screenshot: tr("正在保存页面快照", "Capturing page screenshot"),\n      browser_console: tr("正在检查浏览器控制台", "Inspecting browser console"),\n      browser_network: tr("正在检查网络请求", "Inspecting browser network"),\n      browser_close: tr("正在关闭浏览器会话", "Closing browser session"),\n      update_plan: tr("正在更新执行计划", "Updating the execution plan"),`,
  },
]);

await rm("scripts/apply-browser-integration.mjs", { force: true });
await rm(".github/workflows/apply-browser-integration.yml", { force: true });
console.log("browser integration patch applied");
