import fs from "node:fs/promises";
import { CONTROL_TOOLS, callControlTool } from "./catalog.js";
import { ControlClientError, createControlClient } from "./client.js";
import { startMcpServer } from "./server.js";

const MAX_INPUT_BYTES = 512 * 1024;
export const HELP = `AporiaX local control bridge

Usage: control-bridge <command> --connection <absolute-private-json-path> [options]

Commands:
  mcp                         MCP stdio server (default; stdout is protocol only)
  status                      Desktop/API status and authorized capabilities
  openapi                     Authenticated OpenAPI 3.1 schema
  workspaces | profiles | providers
  runs [--limit N] [--before RUN_ID]
  run --input <json-file|->    Create a run; '-' reads a JSON object from stdin
  run --workspace ID --profile review|workspace --instruction TEXT --request-id KEY
  get | result | agents | questions | approvals | artifacts RUN_ID
  events RUN_ID [--after-seq N] [--limit N]
  message RUN_ID --content TEXT
  answer RUN_ID QUESTION_ID --answer TEXT
  pause | resume | cancel RUN_ID
  artifact RUN_ID ARTIFACT_ID [--offset N] [--limit N]
  tools                       Print the MCP tool schemas without connecting
  help                        Show this help

Every API command accepts --input FILE|- or --json '{...}' for its JSON arguments.
Use snake_case keys in JSON. Run options: --provider ID --model ID, and
--max-duration-seconds N --max-model-calls N --max-tool-calls N
--max-parallel-agents N --max-subagents N.

Keep --request-id / idempotency_key stable when retrying the SAME logical task.
Creation returns immediately with run_id. Query get/events/result to follow it.
Closing the bridge does not cancel accepted tasks. Only cancel explicitly does.
Credentials are read from the private connection file, never --token or argv.
CLI stdout contains one JSON response; errors go to stderr with a nonzero exit.
`;

const FLAG_FIELDS = {
  workspace: "workspace_id", profile: "profile", instruction: "instruction", "request-id": "idempotency_key",
  provider: "provider_id", model: "model_id", content: "content", answer: "answer",
  limit: "limit", before: "before", "after-seq": "after_seq", offset: "offset",
};
const LIMIT_FLAGS = ["max-duration-seconds", "max-model-calls", "max-tool-calls", "max-parallel-agents", "max-subagents"];
const NUMBER_FLAGS = new Set(["limit", "after-seq", "offset", ...LIMIT_FLAGS]);
const SPECIAL_FLAGS = new Set(["connection", "input", "json"]);
const COMMANDS = {
  status: "status", workspaces: "list_workspaces", profiles: "list_profiles", providers: "list_providers",
  runs: "list_runs", run: "start_run", get: "get_run", result: "get_result", events: "read_events",
  agents: "list_agents", questions: "list_questions", approvals: "list_approvals", artifacts: "list_artifacts",
  message: "send_message", answer: "answer_question", pause: "pause_run", resume: "resume_run", cancel: "cancel_run", artifact: "read_artifact",
};
const RUN_COMMANDS = new Set(["get", "result", "events", "agents", "questions", "approvals", "artifacts", "message", "answer", "pause", "resume", "cancel", "artifact"]);
const cliError = message => { throw new ControlClientError("CLI_ARGUMENTS", message); };

function parseArguments(argv) {
  const options = {};
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--help" || item === "-h") return { command: "help", options, positional: [] };
    if (!item.startsWith("--")) { positional.push(item); continue; }
    const name = item.slice(2);
    if (name === "token") cliError("Do not pass tokens on the command line. Use --connection with the private JSON file created by AporiaX.");
    if (!Object.hasOwn(FLAG_FIELDS, name) && !LIMIT_FLAGS.includes(name) && !SPECIAL_FLAGS.has(name)) cliError("Unknown option. Run 'control-bridge help' to list accepted options.");
    if (Object.hasOwn(options, name)) cliError("Duplicate option. Supply each command-line option once.");
    if (index + 1 >= argv.length || argv[index + 1].startsWith("--")) cliError("Missing option value. Run 'control-bridge help' for usage.");
    options[name] = argv[++index];
  }
  return { command: positional.shift() || "mcp", options, positional };
}

async function readJsonInput(filename) {
  if (filename === "-") {
    if (process.stdin.isTTY) cliError("--input - expects a piped JSON object on stdin.");
    const chunks = [];
    let size = 0;
    for await (const chunk of process.stdin) {
      size += chunk.length;
      if (size > MAX_INPUT_BYTES) cliError("JSON input exceeds 512 KiB.");
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString("utf8");
  }
  let handle;
  try {
    handle = await fs.open(filename, "r");
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_INPUT_BYTES) cliError("JSON input must be a regular file smaller than 512 KiB.");
    return await handle.readFile("utf8");
  } catch (error) {
    if (error instanceof ControlClientError) throw error;
    cliError("Unable to read the input JSON file.");
  } finally {
    await handle?.close();
  }
}

function setField(target, field, value) {
  if (Object.hasOwn(target, field)) cliError(`Specify ${field} only once, using JSON or command-line options.`);
  target[field] = value;
}

export async function runCli(argv = process.argv.slice(2)) {
  const { command, options, positional } = parseArguments(argv);
  if (command === "help") { process.stdout.write(HELP); return; }
  if (command === "tools") {
    process.stdout.write(JSON.stringify({ tools: CONTROL_TOOLS.map(({ invoke, ...definition }) => definition) }, null, 2) + "\n");
    return;
  }
  if (command !== "mcp" && command !== "openapi" && !Object.hasOwn(COMMANDS, command)) cliError("Unknown command. Run 'control-bridge help' to list accepted commands.");
  const client = createControlClient({ connectionPath: options.connection });
  if (command === "mcp") {
    if (positional.length || Object.keys(options).some(name => name !== "connection")) cliError("MCP mode accepts only --connection. Task arguments are supplied through tools/call.");
    await startMcpServer(client);
    return;
  }
  if (options.input && options.json) cliError("Choose either --input or --json.");
  let input = {};
  if (options.input || options.json) {
    const source = options.input ? await readJsonInput(options.input) : options.json;
    if (Buffer.byteLength(source) > MAX_INPUT_BYTES) cliError("JSON input exceeds 512 KiB.");
    try { input = JSON.parse(source); } catch { cliError("Input is not valid JSON. Expected a single JSON object."); }
    if (!input || typeof input !== "object" || Array.isArray(input)) cliError("Input must be a JSON object.");
  }
  for (const [name, raw] of Object.entries(options)) {
    if (SPECIAL_FLAGS.has(name)) continue;
    const value = NUMBER_FLAGS.has(name) ? (/^\d+$/.test(raw) ? Number(raw) : NaN) : raw;
    if (NUMBER_FLAGS.has(name) && !Number.isSafeInteger(value)) cliError("Numeric options must be nonnegative safe integers.");
    if (LIMIT_FLAGS.includes(name)) {
      if (input.limits !== undefined && (!input.limits || typeof input.limits !== "object" || Array.isArray(input.limits))) cliError("limits must be a JSON object.");
      input.limits ||= {};
      setField(input.limits, name.replaceAll("-", "_"), value);
    } else setField(input, FLAG_FIELDS[name], value);
  }
  if (RUN_COMMANDS.has(command) && positional.length) setField(input, "run_id", positional.shift());
  if (command === "answer" && positional.length) setField(input, "question_id", positional.shift());
  if (command === "artifact" && positional.length) setField(input, "artifact_id", positional.shift());
  if (positional.length) cliError("Too many positional arguments. Use --instruction, --content or a JSON input file for text.");
  if (command === "openapi") {
    if (Object.keys(input).length) cliError("openapi takes no task arguments.");
    process.stdout.write(JSON.stringify(await client.request("GET", "/openapi"), null, 2) + "\n");
    return;
  }
  const result = await callControlTool(`aporiax_${COMMANDS[command]}`, input, client);
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}
