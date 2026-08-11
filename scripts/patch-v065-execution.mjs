import { readFile, writeFile } from "node:fs/promises";

async function edit(path, transform) {
  const before = await readFile(path, "utf8");
  const after = transform(before);
  if (after === before) throw new Error(`Patch produced no change: ${path}`);
  await writeFile(path, after, "utf8");
}

function replaceOnce(content, before, after, label) {
  const first = content.indexOf(before);
  if (first < 0) throw new Error(`Missing patch anchor: ${label}`);
  if (content.indexOf(before, first + before.length) >= 0) {
    throw new Error(`Ambiguous patch anchor: ${label}`);
  }
  return content.slice(0, first) + after + content.slice(first + before.length);
}

await edit("src/models/model-catalog.js", (content) =>
  replaceOnce(
    content,
    '  approvalMode: "sandbox-auto",\n};',
    '  approvalMode: "sandbox-auto",\n  executionMode: "safe",\n};',
    "default task execution mode",
  ),
);

await edit("src/settings/SettingsPanel.jsx", (content) => {
  content = replaceOnce(
    content,
    'import { IconButton, Switch } from "../components/Controls.jsx";',
    'import { IconButton, SegmentedControl, Switch } from "../components/Controls.jsx";',
    "settings control import",
  );
  content = replaceOnce(
    content,
    '  const provider =\n    providers.find((candidate) => candidate.id === task.providerId) ||\n    providers[0];\n  return (',
    '  const provider =\n    providers.find((candidate) => candidate.id === task.providerId) ||\n    providers[0];\n  const executionMode = ["direct", "safe", "isolated"].includes(task.executionMode)\n    ? task.executionMode\n    : "safe";\n  return (',
    "settings execution mode state",
  );
  content = replaceOnce(
    content,
    '        <div className="settings-label">{tr("命令沙箱", "Command sandbox")}</div>\n        <div className="sandbox-status-card">',
    '        <div className="settings-label">{tr("执行模式", "Execution mode")}</div>\n        <SegmentedControl\n          value={executionMode}\n          ariaLabel={tr("命令执行模式", "Command execution mode")}\n          options={[\n            { value: "direct", label: tr("直接", "Direct") },\n            { value: "safe", label: tr("安全", "Safe") },\n            { value: "isolated", label: tr("隔离", "Isolated") },\n          ]}\n          onChange={(nextMode) => onUpdateTask({ executionMode: nextMode })}\n        />\n        <p className="settings-language-note">\n          {executionMode === "direct"\n            ? tr("直接在真实工作区执行，速度最快；智能 Permission 会拦截未知或高风险命令。", "Runs in the real workspace for maximum speed; smart Permission gates unknown and high-risk commands.")\n            : executionMode === "safe"\n              ? tr("在临时工作区副本执行并冲突检查后同步；仍使用本机网络与进程权限。", "Runs in a temporary workspace copy and conflict-checks synchronization; host network and process authority remain available.")\n              : tr("只在 Docker 强隔离环境执行；Docker 未就绪时不会静默降级到 Host。", "Runs only inside the Docker isolation profile; it never silently falls back to Host when Docker is unavailable.")}\n        </p>\n        <div className="sandbox-status-card">',
    "execution selector",
  );
  content = replaceOnce(
    content,
    '              {!sandboxStatus\n                ? tr("正在检测沙箱", "Checking sandbox")\n                : sandboxStatus.available\n                  ? tr("Docker 强隔离已就绪", "Docker strong isolation ready")\n                  : sandboxStatus.localAvailable\n                    ? tr("本地沙箱已就绪", "Local sandbox ready")\n                    : tr("沙箱暂不可用", "Sandbox unavailable")}',
    '              {!sandboxStatus\n                ? tr("正在检测执行环境", "Checking execution environment")\n                : executionMode === "direct"\n                  ? tr("Direct · 真实工作区", "Direct · real workspace")\n                  : executionMode === "safe"\n                    ? tr("Safe · 临时工作区副本", "Safe · temporary workspace copy")\n                    : sandboxStatus.available\n                      ? tr("Isolated · Docker 已就绪", "Isolated · Docker ready")\n                      : tr("Isolated · Docker 尚未就绪", "Isolated · Docker not ready")}',
    "status title",
  );
  content = replaceOnce(
    content,
    '              {sandboxStatus?.detail ||\n                tr("正在检测 Docker 与 AporiaX 沙箱镜像", "Checking Docker and the AporiaX sandbox image")}',
    '              {executionMode === "direct"\n                ? tr("命令直接使用 Host 工作区；敏感环境变量仍会过滤。", "Commands use the Host workspace directly; sensitive environment variables are still filtered.")\n                : executionMode === "safe"\n                  ? tr("命令在临时副本执行，结束后进行 Hash 冲突检查与同步。", "Commands run in a temporary copy, followed by hash-based conflict checks and synchronization.")\n                  : sandboxStatus?.detail ||\n                    tr("正在检测 Docker 与 AporiaX 沙箱镜像", "Checking Docker and the AporiaX sandbox image")}',
    "status detail",
  );
  content = replaceOnce(
    content,
    '        {!sandboxStatus?.available && (',
    '        {executionMode === "isolated" && !sandboxStatus?.available && (',
    "docker prepare visibility",
  );
  content = replaceOnce(
    content,
    '        {sandboxStatus?.available && (\n          <div className="sandbox-constraints">',
    '        {executionMode === "isolated" && sandboxStatus?.available && (\n          <div className="sandbox-constraints">',
    "isolated constraints visibility",
  );
  content = replaceOnce(
    content,
    '        {sandboxStatus && !sandboxStatus.available && (\n          <div className="sandbox-constraints fallback">\n            <span>{tr("临时工作区", "Temporary workspace")}</span>\n            <span>{tr("自动执行", "Automatic execution")}</span>\n            <span>{tr("使用本机网络", "Host network")}</span>\n            <span>{tr("Docker 可选", "Docker optional")}</span>\n          </div>\n        )}',
    '        {sandboxStatus && executionMode !== "isolated" && (\n          <div className="sandbox-constraints fallback">\n            <span>{executionMode === "direct" ? tr("真实工作区", "Real workspace") : tr("临时工作区", "Temporary workspace")}</span>\n            <span>{tr("智能审批", "Smart approval")}</span>\n            <span>{tr("使用本机网络", "Host network")}</span>\n            <span>{executionMode === "direct" ? tr("无隔离", "No isolation") : tr("冲突检查同步", "Conflict-checked sync")}</span>\n          </div>\n        )}',
    "direct safe constraints",
  );
  content = replaceOnce(
    content,
    '                "本地临时工作区与 Docker 沙箱内的命令不再逐条确认；关闭后恢复手动审批。",\n                "Commands in the local temporary workspace and Docker sandbox run without repeated prompts. Turn this off to restore manual approval.",',
    '                "开启后，仅命中智能 Permission 低风险规则的命令自动执行；依赖安装、网络写入、破坏性操作等仍会询问或拒绝。",\n                "When enabled, only commands recognized as low risk by smart Permission auto-run; dependency mutation, remote writes, destructive operations, and similar risks still ask or deny.",',
    "smart approval copy",
  );
  return content;
});

await edit("electron/preload.cjs", (content) => {
  content = replaceOnce(
    content,
    'const { contextBridge, ipcRenderer } = require("electron");\n\ncontextBridge.exposeInMainWorld("desktop", {',
    'const { contextBridge, ipcRenderer } = require("electron");\n\nconst taskExecutionModes = new Map();\nconst normalizeExecutionMode = (value) =>\n  ["direct", "safe", "isolated"].includes(value) ? value : "safe";\nconst rememberTaskExecutionModes = (tasks) => {\n  for (const task of Array.isArray(tasks) ? tasks : []) {\n    if (!task?.id) continue;\n    taskExecutionModes.set(task.id, normalizeExecutionMode(task.executionMode));\n  }\n  return tasks;\n};\n\ncontextBridge.exposeInMainWorld("desktop", {',
    "preload mode cache",
  );
  content = replaceOnce(
    content,
    '  tasks: {\n    load: () => ipcRenderer.invoke("tasks:load"),\n    save: (tasks) => ipcRenderer.invoke("tasks:save", tasks),\n  },',
    '  tasks: {\n    load: () =>\n      ipcRenderer.invoke("tasks:load").then((tasks) => rememberTaskExecutionModes(tasks)),\n    save: (tasks) => {\n      rememberTaskExecutionModes(tasks);\n      return ipcRenderer.invoke("tasks:save", tasks);\n    },\n  },',
    "preload task persistence bridge",
  );
  content = replaceOnce(
    content,
    '    run: (request) => ipcRenderer.invoke("harness:run", request),',
    '    run: (request) =>\n      ipcRenderer.invoke("harness:run", {\n        ...request,\n        executionMode: normalizeExecutionMode(\n          request?.executionMode || taskExecutionModes.get(request?.taskId),\n        ),\n      }),',
    "preload harness execution mode",
  );
  return content;
});

await edit("electron/harness/agent-budget.js", (content) => {
  content = replaceOnce(
    content,
    'const budgetStorage = new AsyncLocalStorage();\nconst PROFILE_ORDER = ["direct", "read", "light", "standard", "large"];',
    'const budgetStorage = new AsyncLocalStorage();\nconst EXECUTION_MODES = new Set(["direct", "safe", "isolated"]);\nconst normalizeExecutionMode = (value, fallback = "safe") =>\n  EXECUTION_MODES.has(value) ? value : fallback;\nconst PROFILE_ORDER = ["direct", "read", "light", "standard", "large"];',
    "budget execution mode helpers",
  );
  content = replaceOnce(
    content,
    '  const limits = mergeLimits(PROFILE_LIMITS[profile], options?.agentBudget || {});\n  return Object.freeze({\n    version: 1,\n    profile,',
    '  const limits = mergeLimits(PROFILE_LIMITS[profile], options?.agentBudget || {});\n  const executionMode = normalizeExecutionMode(options?.executionMode);\n  return Object.freeze({\n    version: 1,\n    profile,\n    executionMode,',
    "budget plan execution mode",
  );
  content = replaceOnce(
    content,
    '    ...context.plan,\n    profile: context.profile,\n    limits: context.limits,',
    '    ...context.plan,\n    profile: context.profile,\n    executionMode: context.executionMode,\n    limits: context.limits,',
    "public budget execution mode",
  );
  content = replaceOnce(
    content,
    'export function currentAgentBudget() {\n  return publicPlan(budgetStorage.getStore());\n}\n\nexport function runWithAgentBudget(plan, { onEvent = null } = {}, fn) {',
    'export function currentAgentBudget() {\n  return publicPlan(budgetStorage.getStore());\n}\n\nexport function currentExecutionMode() {\n  return budgetStorage.getStore()?.executionMode || null;\n}\n\nexport function runWithAgentBudget(plan, { onEvent = null } = {}, fn) {',
    "current execution mode export",
  );
  content = replaceOnce(
    content,
    '  const normalized = plan?.limits ? plan : planAgentBudget({});\n  const context = {\n    plan: normalized,\n    profile: normalized.profile,\n    limits: normalized.limits,',
    '  const normalized = plan?.limits ? plan : planAgentBudget({});\n  const parentContext = budgetStorage.getStore();\n  const context = {\n    plan: normalized,\n    profile: normalized.profile,\n    executionMode: normalized.executionMode\n      ? normalizeExecutionMode(normalized.executionMode)\n      : parentContext?.executionMode || "safe",\n    limits: normalized.limits,',
    "budget context execution mode",
  );
  content = replaceOnce(
    content,
    '    type: "agent_budget.planned",\n    profile: context.profile,\n    reason: normalized.reason,',
    '    type: "agent_budget.planned",\n    profile: context.profile,\n    executionMode: context.executionMode,\n    reason: normalized.reason,',
    "budget planned event execution mode",
  );
  return content;
});

await edit("electron/sandbox-runtime.js", (content) => {
  content = replaceOnce(
    content,
    'import { spawn, spawnSync } from "node:child_process";\n',
    'import { spawn, spawnSync } from "node:child_process";\nimport { currentExecutionMode } from "./harness/agent-budget.js";\n',
    "sandbox execution context import",
  );
  content = replaceOnce(
    content,
    'export async function getSandboxStatus() {',
    'async function getSandboxEngineStatus() {',
    "raw sandbox status rename",
  );
  content = replaceOnce(
    content,
    'export async function prepareSandbox({\n  dataDirectory,',
    'export function projectSandboxStatusForExecutionMode(status, executionMode = null) {\n  const mode = ["direct", "safe", "isolated"].includes(executionMode)\n    ? executionMode\n    : null;\n  if (!mode) return status;\n  const dockerAvailable = Boolean(status?.available);\n  if (mode === "direct") {\n    return {\n      ...status,\n      executionProfile: "direct",\n      dockerAvailable,\n      backend: "host",\n      available: false,\n      localAvailable: false,\n      autoApprovalSafe: false,\n      fallbackAvailable: true,\n      executionMode: "host",\n      network: "host",\n      filesystem: "workspace-write",\n      rootFilesystem: "host",\n      isolation: "none",\n      detail: "Direct execution selected: commands use the real workspace and host authority. Smart Permission remains active.",\n    };\n  }\n  if (mode === "safe") {\n    return {\n      ...status,\n      executionProfile: "safe",\n      dockerAvailable,\n      backend: "local-workspace",\n      available: false,\n      localAvailable: true,\n      autoApprovalSafe: true,\n      fallbackAvailable: true,\n      executionMode: "local-workspace",\n      network: "host",\n      filesystem: "temporary-workspace-copy",\n      rootFilesystem: "host",\n      isolation: "workspace-copy",\n      detail: "Safe execution selected: commands use a temporary workspace copy with conflict-checked synchronization and host process/network authority.",\n    };\n  }\n  return {\n    ...status,\n    executionProfile: "isolated",\n    dockerAvailable,\n    backend: "docker",\n    localAvailable: false,\n    autoApprovalSafe: dockerAvailable,\n    fallbackAvailable: false,\n    executionMode: "container",\n    detail: dockerAvailable\n      ? status.detail\n      : `Isolated execution selected, but Docker is not ready. ${status?.detail || ""}`.trim(),\n  };\n}\n\nexport async function getSandboxStatus() {\n  const status = await getSandboxEngineStatus();\n  return projectSandboxStatusForExecutionMode(status, currentExecutionMode());\n}\n\nexport async function prepareSandbox({\n  dataDirectory,',
    "execution-aware status projection",
  );
  content = replaceOnce(
    content,
    '  const status = await getSandboxStatus();\n  if (status.state === "cli-missing") {',
    '  const status = await getSandboxEngineStatus();\n  if (status.state === "cli-missing") {',
    "prepare raw status",
  );
  content = replaceOnce(
    content,
    'export function createHostFallbackEnvironment(\n  sourceEnvironment = process.env,\n) {',
    'export function createHostFallbackEnvironment(\n  sourceEnvironment = process.env,\n  executionMarker = "local-workspace-sandbox",\n) {',
    "host environment marker signature",
  );
  content = replaceOnce(
    content,
    '  environment.APORIAX_EXECUTION_MODE = "local-workspace-sandbox";',
    '  environment.APORIAX_EXECUTION_MODE = executionMarker;',
    "host environment marker value",
  );
  content = replaceOnce(
    content,
    '        backend: "docker",\n        container: containerName,',
    '        backend: "docker",\n        executionProfile: "isolated",\n        container: containerName,',
    "docker evidence profile",
  );
  content = replaceOnce(
    content,
    '        backend: "local-workspace",\n        fallback: true,',
    '        backend: "local-workspace",\n        executionProfile: "safe",\n        fallback: true,',
    "safe evidence profile",
  );
  content = replaceOnce(
    content,
    '    env: createHostFallbackEnvironment(),\n    signal,\n    timeoutMs,\n    onOutput,\n    onWatchdog,\n    watchdogSlowMs,\n  });\n  return {\n    ...result,\n    sandbox: {\n      backend: "host",',
    '    env: createHostFallbackEnvironment(process.env, "host-direct"),\n    signal,\n    timeoutMs,\n    onOutput,\n    onWatchdog,\n    watchdogSlowMs,\n  });\n  return {\n    ...result,\n    sandbox: {\n      backend: "host",\n      executionProfile: "direct",',
    "direct host environment and evidence",
  );
  content = replaceOnce(
    content,
    'export async function runCommandWithFallback(options) {\n  const status =\n    options.sandboxStatus || (await getSandboxStatus());\n  if (status.available) {\n    return runSandboxedCommand({\n      ...options,\n      sandboxStatus: status,\n    });\n  }\n  return runLocalSandboxedCommand({\n    ...options,\n    sandboxStatus: status,\n  });\n}',
    'export async function runCommandWithFallback(options) {\n  const status = options.sandboxStatus || (await getSandboxStatus());\n  const mode = currentExecutionMode() || status?.executionProfile || null;\n  if (mode === "direct") {\n    return runHostFallbackCommand({\n      ...options,\n      sandboxStatus: status,\n    });\n  }\n  if (mode === "safe") {\n    return runLocalSandboxedCommand({\n      ...options,\n      sandboxStatus: status,\n    });\n  }\n  if (mode === "isolated") {\n    if (!status.available) {\n      throw new Error(\n        `Isolated execution requires a ready Docker sandbox. ${status?.detail || ""}`.trim(),\n      );\n    }\n    return runSandboxedCommand({\n      ...options,\n      sandboxStatus: status,\n    });\n  }\n  // Compatibility path for callers outside a task-scoped execution context.\n  if (status.available) {\n    return runSandboxedCommand({\n      ...options,\n      sandboxStatus: status,\n    });\n  }\n  return runLocalSandboxedCommand({\n    ...options,\n    sandboxStatus: status,\n  });\n}',
    "execution backend routing",
  );
  return content;
});

await edit("electron/runtime/tool-permissions.js", (content) =>
  replaceOnce(
    content,
    '  const mode = executionMode\n    ? normalizeExecutionMode(executionMode)\n    : sandboxStatus?.available\n      ? "isolated"\n      : "safe";',
    '  const mode = executionMode\n    ? normalizeExecutionMode(executionMode)\n    : sandboxStatus?.executionProfile\n      ? normalizeExecutionMode(sandboxStatus.executionProfile)\n      : sandboxStatus?.available\n        ? "isolated"\n        : "safe";',
    "permission execution mode inference",
  ),
);

await edit("electron/runtime/process-runtime.js", (content) => {
  content = replaceOnce(
    content,
    'import { createHostFallbackEnvironment } from "../sandbox-runtime.js";',
    'import { createHostFallbackEnvironment } from "../sandbox-runtime.js";\nimport { currentExecutionMode } from "../harness/agent-budget.js";',
    "persistent process execution import",
  );
  content = replaceOnce(
    content,
    '    finishedAt: record.finishedAt,\n    cursor: record.baseOffset + record.output.length,',
    '    finishedAt: record.finishedAt,\n    requestedExecutionMode: record.requestedExecutionMode,\n    executionBackend: "host",\n    cursor: record.baseOffset + record.output.length,',
    "persistent process public execution metadata",
  );
  content = replaceOnce(
    content,
    '      const shell = shellCommand(normalized);\n      const child = spawn(shell.program, shell.args, {\n        cwd,\n        env: createHostFallbackEnvironment(),',
    '      const requestedExecutionMode = currentExecutionMode() || "safe";\n      if (requestedExecutionMode === "isolated") {\n        throw new Error(\n          "Persistent terminal processes do not silently fall back to Host in Isolated mode. Use a bounded run_command or switch this task to Direct/Safe mode.",\n        );\n      }\n      const shell = shellCommand(normalized);\n      const child = spawn(shell.program, shell.args, {\n        cwd,\n        env: createHostFallbackEnvironment(process.env, "persistent-host"),',
    "persistent process isolated boundary",
  );
  content = replaceOnce(
    content,
    '        finishedAt: null,\n      };',
    '        finishedAt: null,\n        requestedExecutionMode,\n      };',
    "persistent process requested mode record",
  );
  return content;
});

await edit("package.json", (content) =>
  replaceOnce(
    content,
    '    "test:execution-policy": "node tests/execution-policy-smoke.mjs",\n    "test:tool-permissions": "node tests/tool-permissions-smoke.mjs",',
    '    "test:execution-policy": "node tests/execution-policy-smoke.mjs",\n    "test:execution-wiring": "node tests/execution-mode-wiring-smoke.mjs",\n    "test:tool-permissions": "node tests/tool-permissions-smoke.mjs",',
    "execution wiring test script",
  ),
);

await writeFile(
  "tests/execution-mode-wiring-smoke.mjs",
  `import assert from "node:assert/strict";\nimport {\n  currentExecutionMode,\n  planAgentBudget,\n  runWithAgentBudget,\n} from "../electron/harness/agent-budget.js";\nimport { projectSandboxStatusForExecutionMode } from "../electron/sandbox-runtime.js";\n\nconst directPlan = planAgentBudget({ executionMode: "direct" });\nassert.equal(directPlan.executionMode, "direct");\nawait runWithAgentBudget(directPlan, {}, async () => {\n  assert.equal(currentExecutionMode(), "direct");\n  const nestedPlan = { ...planAgentBudget({}), executionMode: undefined };\n  await runWithAgentBudget(nestedPlan, {}, async () => {\n    assert.equal(currentExecutionMode(), "direct");\n  });\n});\nassert.equal(currentExecutionMode(), null);\n\nconst rawDockerReady = {\n  backend: "docker",\n  state: "ready",\n  available: true,\n  localAvailable: true,\n  autoApprovalSafe: true,\n  detail: "Docker ready",\n};\nconst direct = projectSandboxStatusForExecutionMode(rawDockerReady, "direct");\nassert.equal(direct.executionProfile, "direct");\nassert.equal(direct.backend, "host");\nassert.equal(direct.available, false);\nassert.equal(direct.dockerAvailable, true);\nconst safe = projectSandboxStatusForExecutionMode(rawDockerReady, "safe");\nassert.equal(safe.executionProfile, "safe");\nassert.equal(safe.backend, "local-workspace");\nassert.equal(safe.available, false);\nassert.equal(safe.localAvailable, true);\nconst isolated = projectSandboxStatusForExecutionMode(rawDockerReady, "isolated");\nassert.equal(isolated.executionProfile, "isolated");\nassert.equal(isolated.backend, "docker");\nassert.equal(isolated.available, true);\nconst isolatedUnavailable = projectSandboxStatusForExecutionMode(\n  { ...rawDockerReady, available: false, state: "engine-stopped" },\n  "isolated",\n);\nassert.equal(isolatedUnavailable.available, false);\nassert.equal(isolatedUnavailable.fallbackAvailable, false);\n\nconsole.log("execution mode wiring smoke: PASS");\n`,
  "utf8",
);

await edit("docs/releases/v0.6.5.md", (content) =>
  replaceOnce(
    content,
    '## Next implementation slices\n\nThe remaining 0.6.5 work should land as reviewable follow-up PRs on top of this foundation:\n\n1. wire the three execution profiles through task settings, Runtime, persistent processes, Builder verification, and Evidence;\n2. add native Git write operations and GitHub branch/commit/push/pull/PR/CI capabilities behind the permission engine;\n3. add a persistent LSP manager with diagnostics, definition, references, hover, document symbols, and workspace symbols;\n4. unify long-running processes and LSP servers under task-scoped execution sessions;\n5. add workspace trust and scoped secret/environment policies before expanding automatic host execution.',
    '## Implementation slices\n\nThe first 0.6.5 execution slice now wires the selected profile from task settings through the desktop preload boundary, task-scoped Agent Budget context, Permission projection, and the actual run_command backend. Direct always uses Host, Safe always uses the temporary workspace-copy backend, and Isolated requires Docker without silent fallback. Persistent processes remain an explicitly approved Host capability in Direct/Safe and are blocked from Host fallback in Isolated mode.\n\nThe remaining 0.6.5 work should land as reviewable follow-up PRs:\n\n1. add native Git write operations and GitHub branch/commit/push/pull/PR/CI capabilities behind the permission engine;\n2. add a persistent LSP manager with diagnostics, definition, references, hover, document symbols, and workspace symbols;\n3. evolve long-running Safe/Isolated process backends so persistent services can share the selected execution profile instead of using the approved Host exception;\n4. add workspace trust and scoped secret/environment policies before expanding automatic host execution.',
    "release execution slice status",
  ),
);

console.log("v0.6.5 execution wiring patch applied");
