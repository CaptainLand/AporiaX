import { TOOL_DEFINITIONS } from "./native-tool-catalog.js";

let applied = false;

function overrideToolDescription(name, description) {
  const tool = TOOL_DEFINITIONS.find(
    (definition) => definition?.function?.name === name,
  );
  if (tool?.function) tool.function.description = description;
  return tool?.function || null;
}

export function applyRuntimeToolDefinitionOverrides() {
  if (applied) return;
  applied = true;

  const externalRead = overrideToolDescription(
    "read_external_file",
    "Read a UTF-8 text file, extract text from a PDF, or list the direct children of a directory outside the workspace using an absolute path. External access is strictly read-only and never expands write permission beyond the authorized workspace.",
  );
  if (externalRead) {
    const pathProperty = externalRead.parameters?.properties?.path;
    if (pathProperty) {
      pathProperty.description =
        "Absolute external file or directory path. Directories return a bounded non-recursive listing.";
    }
    const reasonProperty = externalRead.parameters?.properties?.reason;
    if (reasonProperty) {
      reasonProperty.description =
        "Concise reason this read-only external reference is useful for the current task.";
    }
  }

  overrideToolDescription(
    "start_process",
    "Start a managed persistent terminal process for a conventional dev server, watcher, REPL, or interactive command. Recognized workspace development servers run autonomously in automatic mode; unknown host-authority commands still require approval.",
  );
  overrideToolDescription(
    "git_push",
    "Push an explicit branch to a remote. Normal non-protected branches may be pushed autonomously; force push is unsupported and protected or ambiguous destinations require approval. Supply branch explicitly for autonomous execution.",
  );
  overrideToolDescription(
    "github_pr_create",
    "Create a GitHub pull request through the authenticated GitHub CLI. Pull-request creation is a reversible review action and may run autonomously; GitHub credentials are never exposed to the model.",
  );
  overrideToolDescription(
    "browser_click",
    "Click one element in AporiaX's fresh isolated browser session. Ordinary page interaction is autonomous in workspace-write mode; the browser does not reuse the user's personal browser profile or cookies.",
  );
  overrideToolDescription(
    "browser_fill",
    "Fill a text field in AporiaX's fresh isolated browser session. Ordinary form interaction is autonomous in workspace-write mode; never request or enter secrets unless the user explicitly supplied them for this task.",
  );
  overrideToolDescription(
    "browser_press",
    "Press a keyboard key on a located element or on the page in AporiaX's isolated browser session. Ordinary interaction is autonomous in workspace-write mode.",
  );
}