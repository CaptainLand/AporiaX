import { createHostFallbackEnvironment } from "../sandbox-runtime.js";

export function interactiveTerminalEnvironment(source = process.env) {
  const environment = createHostFallbackEnvironment(source, "workbench-terminal");
  for (const name of ["CI", "NO_COLOR"]) {
    if (!Object.keys(source).some((key) => key.toUpperCase() === name)) delete environment[name];
  }
  return environment;
}
