import { readFile, writeFile, rm } from "node:fs/promises";

function replaceOnce(source, before, after, label) {
  const count = source.split(before).length - 1;
  if (count !== 1) throw new Error(`expected one ${label} anchor, found ${count}`);
  return source.replace(before, after);
}

function replaceSection(source, startMarker, endMarker, replacement, label) {
  const start = source.indexOf(startMarker);
  const endStart = source.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || endStart < 0) throw new Error(`missing ${label} section anchor`);
  const end = endStart + endMarker.length;
  return `${source.slice(0, start)}${replacement}${source.slice(end)}`;
}

let main = await readFile("src/main.jsx", "utf8");
main = replaceOnce(
  main,
  `    <article\n      className={\`assistant-message \${failed ? "error" : ""} \${interrupted ? "interrupted" : ""}\`}\n    >`,
  `    <article\n      className={\`assistant-message \${failed ? "error" : ""} \${interrupted ? "interrupted" : ""}\`}\n      data-message-id={message.id}\n    >`,
  "assistant message id",
);
await writeFile("src/main.jsx", main, "utf8");

let enhancements = await readFile("src/runtime-ui-enhancements.jsx", "utf8");
enhancements = replaceOnce(
  enhancements,
  `const durationRoots = new Map();\nconst processRoots = new Map();`,
  `const durationRoots = new Map();\nconst processRoots = new Map();\nconst durationMessageByHeading = new WeakMap();\nconst processMessageByArticle = new WeakMap();`,
  "runtime weak maps",
);
enhancements = replaceOnce(
  enhancements,
  `function currentVisibleTask() {\n  const descriptor = visibleTaskDescriptor();\n  const localTasks = readTaskListFromStorage(window.localStorage);\n  return (\n    selectVisibleTask(localTasks, descriptor) ||\n    selectVisibleTask(authoritativeTasks, descriptor) ||\n    null\n  );\n}`,
  `function currentVisibleTask() {\n  const descriptor = visibleTaskDescriptor();\n  const localTasks = readTaskListFromStorage(window.localStorage);\n  const localTask = selectVisibleTask(localTasks, descriptor);\n  if (localTask?.id) {\n    const authoritativeMatch = authoritativeTasks.find(\n      (task) => task?.id === localTask.id,\n    );\n    if (authoritativeMatch) return authoritativeMatch;\n  }\n  return (\n    selectVisibleTask(authoritativeTasks, descriptor) ||\n    localTask ||\n    null\n  );\n}`,
  "runtime authoritative task selection",
);
enhancements = replaceOnce(
  enhancements,
  `  if (!force && now - lastTaskRefresh < 4_000) return;`,
  `  if (!force && now - lastTaskRefresh < 450) return;`,
  "runtime task refresh throttle",
);
enhancements = replaceSection(
  enhancements,
  `function syncDurationChips() {`,
  `function ProcessStepIcon({ status }) {`,
  `function syncDurationChips() {\n  const task = currentVisibleTask();\n  const headings = [\n    ...document.querySelectorAll(\n      ".message-list .assistant-message .assistant-message-heading",\n    ),\n  ];\n  const messages = (Array.isArray(task?.messages) ? task.messages : []).filter(\n    (message) => message?.role === "assistant",\n  );\n  const messageById = new Map(\n    messages.filter((message) => message?.id).map((message) => [message.id, message]),\n  );\n  const now = Date.now();\n\n  headings.forEach((heading, index) => {\n    const article = heading.closest(".assistant-message");\n    const messageId = article?.dataset?.messageId || "";\n    const freshMessage = messageById.get(messageId) || messages[index] || null;\n    const message = freshMessage || durationMessageByHeading.get(heading) || null;\n    let host = heading.querySelector(\n      ":scope > .aporiax-run-duration-host",\n    );\n    if (!message) return;\n    if (freshMessage) durationMessageByHeading.set(heading, freshMessage);\n    if (!host) {\n      host = document.createElement("span");\n      host.className = "aporiax-run-duration-host";\n      heading.appendChild(host);\n    }\n    let root = durationRoots.get(host);\n    if (!root) {\n      root = createRoot(host);\n      durationRoots.set(host, root);\n    }\n    root.render(<RunDurationChip message={message} now={now} />);\n  });\n\n  for (const host of [...durationRoots.keys()]) {\n    if (!host.isConnected) cleanupRoot(durationRoots, host);\n  }\n}\n\nfunction ProcessStepIcon({ status }) {`,
  "duration sync",
);
enhancements = replaceSection(
  enhancements,
  `function syncProcessTraces() {`,
  `function capabilityStatusText(capability) {`,
  `function syncProcessTraces() {\n  const task = currentVisibleTask();\n  const articles = [\n    ...document.querySelectorAll(".message-list .assistant-message"),\n  ];\n  const messages = (Array.isArray(task?.messages) ? task.messages : []).filter(\n    (message) => message?.role === "assistant",\n  );\n  const messageById = new Map(\n    messages.filter((message) => message?.id).map((message) => [message.id, message]),\n  );\n\n  articles.forEach((article, index) => {\n    const messageId = article.dataset?.messageId || "";\n    const freshMessage = messageById.get(messageId) || messages[index] || null;\n    const message = freshMessage || processMessageByArticle.get(article) || null;\n    const content = article.querySelector(":scope > .assistant-message-content");\n    let host = article.querySelector(":scope > .aporiax-agent-process-host");\n    if (!message || !content) return;\n    if (freshMessage) processMessageByArticle.set(article, freshMessage);\n    const steps = buildAgentProcessSummary(message, languageCode());\n    if (!steps.length) {\n      if (host) cleanupRoot(processRoots, host);\n      return;\n    }\n    if (!host) {\n      host = document.createElement("div");\n      host.className = "aporiax-agent-process-host";\n      content.insertAdjacentElement("afterend", host);\n    }\n    let root = processRoots.get(host);\n    if (!root) {\n      root = createRoot(host);\n      processRoots.set(host, root);\n    }\n    root.render(<AgentProcessTrace message={message} />);\n  });\n\n  for (const host of [...processRoots.keys()]) {\n    if (!host.isConnected) cleanupRoot(processRoots, host);\n  }\n}\n\nfunction capabilityStatusText(capability) {`,
  "process sync",
);
enhancements = replaceSection(
  enhancements,
  `const observer = new MutationObserver(scheduleRefresh);`,
  `]).finally(refreshPresentation);`,
  `const observer = new MutationObserver(scheduleRefresh);\nobserver.observe(document.documentElement, { childList: true, subtree: true });\n\nwindow.desktop?.harness?.onEvent?.(() => {\n  void refreshTasksFromDesktop({ force: true }).finally(scheduleRefresh);\n});\n\nwindow.setInterval(() => {\n  void refreshTasksFromDesktop().finally(scheduleRefresh);\n  if (document.querySelector(".settings-panel")) {\n    void refreshProvidersFromDesktop().finally(scheduleRefresh);\n  }\n  scheduleRefresh();\n}, 1_000);\n\nvoid Promise.all([\n  refreshTasksFromDesktop({ force: true }),\n  refreshProvidersFromDesktop({ force: true }),\n]).finally(refreshPresentation);`,
  "runtime refresh wiring",
);
await writeFile("src/runtime-ui-enhancements.jsx", enhancements, "utf8");

let liveStatus = await readFile("src/live-agent-status.jsx", "utf8");
liveStatus = replaceSection(
  liveStatus,
  `function syncLiveStatuses() {`,
  `function scheduleSync() {`,
  `function syncLiveStatuses() {\n  const task = currentVisibleTask();\n  const articles = [\n    ...document.querySelectorAll(".message-list .assistant-message"),\n  ];\n  const messages = (Array.isArray(task?.messages) ? task.messages : []).filter(\n    (message) => message?.role === "assistant",\n  );\n  const messageById = new Map(\n    messages.filter((message) => message?.id).map((message) => [message.id, message]),\n  );\n\n  articles.forEach((article, index) => {\n    const heading = article.querySelector(":scope > .assistant-message-heading");\n    const content = article.querySelector(":scope > .assistant-message-content");\n    let host = article.querySelector(":scope > .aporiax-live-agent-status-host");\n    const messageId = article.dataset?.messageId || "";\n    const freshMessage = messageById.get(messageId) || messages[index] || null;\n    const message = freshMessage || messageByArticle.get(article) || null;\n\n    if (!heading || !content || !message) return;\n    if (freshMessage) messageByArticle.set(article, freshMessage);\n\n    if (!host) {\n      host = document.createElement("div");\n      host.className = "aporiax-live-agent-status-host";\n      heading.insertAdjacentElement("afterend", host);\n    }\n    let root = roots.get(host);\n    if (!root) {\n      root = createRoot(host);\n      roots.set(host, root);\n    }\n    root.render(\n      <LiveAgentStatus\n        message={message}\n        skills={activatedSkillsByAssistant.get(message.id) || []}\n      />,\n    );\n  });\n\n  for (const host of [...roots.keys()]) {\n    if (!host.isConnected) cleanupHost(host);\n  }\n}\n\nfunction scheduleSync() {`,
  "live status id binding",
);
await writeFile("src/live-agent-status.jsx", liveStatus, "utf8");

let liveCss = await readFile("src/live-agent-status.css", "utf8");
if (!liveCss.includes("Hide the legacy response placeholder")) {
  liveCss += `\n\n/* Hide the legacy response placeholder while the observable live-status row is present.\n   Real response.delta content still renders normally as soon as the model starts answering. */\n.assistant-message:has(> .aporiax-live-agent-status-host) .stream-placeholder {\n  display: none;\n}\n`;
}
await writeFile("src/live-agent-status.css", liveCss, "utf8");

await rm("scripts/apply-live-runtime-sync-fix.mjs", { force: true });
await rm(".github/workflows/apply-live-runtime-sync-fix.yml", { force: true });
console.log("live runtime sync fix applied");
