import { TOOL_DEFINITIONS } from "./native-tool-catalog.js";

let applied = false;

export function applyRuntimeToolDefinitionOverrides() {
  if (applied) return;
  applied = true;

  const externalRead = TOOL_DEFINITIONS.find(
    (definition) => definition?.function?.name === "read_external_file",
  );
  if (!externalRead?.function) return;

  externalRead.function.description =
    "Read a UTF-8 text file, extract text from a PDF, or list the direct children of a directory outside the workspace using an absolute path. External access is strictly read-only and never expands write permission beyond the authorized workspace.";

  const pathProperty = externalRead.function.parameters?.properties?.path;
  if (pathProperty) {
    pathProperty.description =
      "Absolute external file or directory path. Directories return a bounded non-recursive listing.";
  }
  const reasonProperty = externalRead.function.parameters?.properties?.reason;
  if (reasonProperty) {
    reasonProperty.description =
      "Concise reason this read-only external reference is useful for the current task.";
  }
}
