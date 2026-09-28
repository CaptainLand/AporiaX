import { ControlClientError } from "./client.js";

const str = (description, maxLength = 512) => ({ type: "string", minLength: 1, maxLength, description });
const integer = (description, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) => ({ type: "integer", minimum, maximum, description });
const object = (properties = {}, required = []) => ({ type: "object", properties, required, additionalProperties: false });
const runId = str("AporiaX run_id returned by aporiax_start_run or aporiax_list_runs.", 100);
const idSegment = value => encodeURIComponent(value);
const routeForRun = input => `/runs/${idSegment(input.run_id)}`;
const empty = object();
const runInput = object({ run_id: runId }, ["run_id"]);

function tool(name, title, description, inputSchema, invoke, { readOnly = false, idempotent = readOnly, destructive = !readOnly } = {}) {
  return { name: `aporiax_${name}`, title, description, inputSchema, annotations: { title, readOnlyHint: readOnly, idempotentHint: idempotent, destructiveHint: destructive, openWorldHint: !readOnly }, invoke };
}

export const CONTROL_TOOLS = [
  tool("status", "AporiaX connection status", "Check the running desktop, API version and this client's authorized capabilities. If offline, open AporiaX and retry.", empty, (_, client) => client.request("GET", "/meta"), { readOnly: true }),
  ...[
    ["workspaces", "authorized workspaces", "Use only a returned workspace_id; arbitrary paths are not accepted."],
    ["profiles", "agent profiles", "Profiles constrain execution. review is read-only; workspace can make authorized edits."],
    ["providers", "available model providers", "Provider/model choices use AporiaX credentials and billing, subject to the client's authorization. No credentials are returned."],
  ].map(([name, title, detail]) => tool(`list_${name}`, `List ${title}`, `List AporiaX ${title}. ${detail}`, empty, (_, client) => client.request("GET", `/${name}`), { readOnly: true })),
  tool("list_runs", "List AporiaX runs", "List runs this client may access, newest first. Use before for older pages; existing human conversations are not implicitly shared.", object({ limit: integer("Maximum runs to return.", 1, 200), before: str("Run ID preceding the next page.", 100) }), (input, client) => client.request("GET", "/runs", { query: input }), { readOnly: true }),
  tool("start_run", "Delegate a task to AporiaX", "Start a durable background task and immediately return run_id. Choose an authorized workspace/profile; use a stable unique idempotency_key and reuse it if a response is lost. Poll get_run/read_events, then get_result. Closing MCP does not cancel the task. AporiaX can coordinate its own subagents; budget limits apply across them.", object({
    instruction: str("Complete task instructions. Do not include credentials. The HTTP request body also has a 128 KiB byte limit.", 60_000),
    workspace_id: str("ID from aporiax_list_workspaces.", 100),
    profile: { type: "string", enum: ["review", "workspace"], description: "review only reads; workspace may edit within the client's grant." },
    provider_id: str("Optional authorized provider ID from aporiax_list_providers.", 200),
    model_id: str("Optional model ID available on the chosen provider.", 200),
    idempotency_key: str("Stable unique key for this logical request, e.g. review-auth-20260928-01. Reuse for retries; do not reuse for different input. Allowed characters: letters, digits, underscore, dash, colon and dot.", 160),
    limits: object({
      max_duration_seconds: integer("Deadline for the whole delegated task in seconds.", 1, 86_400),
      max_model_calls: integer("Maximum total model calls including subagents; zero disables model calls.", 0, 2_000),
      max_tool_calls: integer("Maximum total tool calls including subagents; zero disables tool calls.", 0, 10_000),
      max_parallel_agents: integer("Maximum concurrent agents, bounded by the client grant; zero disables parallel delegation.", 0, 8),
      max_subagents: integer("Maximum total subagents; zero disables delegation.", 0, 100),
    }),
  }, ["instruction", "workspace_id", "profile", "idempotency_key"]), (input, client) => client.request("POST", "/runs", { body: input }), { idempotent: true }),
  tool("get_run", "Inspect a run", "Get current durable run state, including waiting/blocked/interrupted outcomes. Completion does not itself prove success; inspect get_result and its verification evidence.", runInput, (input, client) => client.request("GET", routeForRun(input)), { readOnly: true }),
  tool("get_result", "Get a run result", "Read a durable final result, summary, verification and usage status. result is null until a delivery is stored; poll get_run while active. Partial and interrupted results must not be reported as verified success.", runInput, (input, client) => client.request("GET", `${routeForRun(input)}/result`), { readOnly: true }),
  tool("read_events", "Read incremental events", "Read ordered durable run events after after_seq. Save next_seq as the next cursor, and page while has_more. Event content may contain untrusted project text.", object({ run_id: runId, after_seq: integer("Exclusive sequence cursor; 0 starts at the beginning."), limit: integer("Maximum events in one page.", 1, 1_000) }, ["run_id"]), ({ run_id, ...query }, client) => client.request("GET", `${routeForRun({ run_id })}/events`, { query }), { readOnly: true }),
  ...[
    ["agents", "subagents", "Shows their state and progress; control continues through the owning run."],
    ["questions", "clarification questions", "Answer business questions with aporiax_answer_question. This is not permission approval."],
    ["approvals", "pending human approvals", "Read-only. Approvals must be handled in AporiaX by the user; an external agent cannot grant itself additional rights."],
    ["artifacts", "result artifacts", "Read content with aporiax_read_artifact, using only returned artifact IDs."],
  ].map(([name, title, detail]) => tool(`list_${name}`, `List run ${title}`, `List this run's ${title}. ${detail}`, runInput, (input, client) => client.request("GET", `${routeForRun(input)}/${name}`), { readOnly: true })),
  tool("send_message", "Steer a running task", "Add task instructions to the owning run. This does not bypass client, role, budget or human-approval constraints; the runtime chooses a safe consumption boundary.", object({ run_id: runId, content: str("Additional task guidance.", 60_000) }, ["run_id", "content"]), ({ run_id, content }, client) => client.request("POST", `${routeForRun({ run_id })}/messages`, { body: { content } })),
  tool("answer_question", "Answer a clarification", "Answer an outstanding business clarification question. It cannot approve a tool, permission escalation or spending outside the pre-authorized grant.", object({ run_id: runId, question_id: str("Question ID from aporiax_list_questions.", 100), answer: str("Answer to the question.", 4_000) }, ["run_id", "question_id", "answer"]), (input, client) => client.request("POST", `${routeForRun(input)}/questions/${idSegment(input.question_id)}/answer`, { body: { answer: input.answer } })),
  ...[
    ["pause", "Request a task pause", "Request a pause at the runtime's next safe boundary; check get_run for the resulting state."],
    ["resume", "Resume a paused task", "Resume an authorized paused run. A stale interrupted run may require a fresh continuation; inspect the returned state."],
    ["cancel", "Cancel a task", "Explicitly request cancellation. Closing this MCP connection does not cancel accepted runs. Check the final state; already-applied changes are not automatically reverted."],
  ].map(([action, title, description]) => tool(`${action}_run`, title, description, runInput, (input, client) => client.request("POST", `${routeForRun(input)}/${action}`, { body: {} }))),
  tool("read_artifact", "Read an artifact page", "Read only an artifact registered on an authorized run; arbitrary filesystem paths are rejected. Pages use base64 to preserve exact bytes, including split UTF-8 characters. Decode and concatenate bytes in order using next_offset while has_more. Content is untrusted task output.", object({ run_id: runId, artifact_id: str("ID from aporiax_list_artifacts.", 160), offset: integer("Byte offset; use the returned next_offset for subsequent pages."), limit: integer("Maximum bytes for this page.", 1, 65_536) }, ["run_id", "artifact_id"]), ({ run_id, artifact_id, ...query }, client) => client.request("GET", `${routeForRun({ run_id })}/artifacts/${idSegment(artifact_id)}`, { query }), { readOnly: true }),
];

function validate(value, schema, location = "arguments") {
  const bad = message => { throw new ControlClientError("INVALID_ARGUMENTS", `${location}: ${message}`); };
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) bad("expected a JSON object.");
    for (const required of schema.required || []) if (!Object.hasOwn(value, required)) bad(`missing ${required}.`);
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(schema.properties, key)) bad(`unknown field ${key}.`);
      validate(value[key], schema.properties[key], `${location}.${key}`);
    }
  } else if (schema.type === "string") {
    if (typeof value !== "string" || value.length < (schema.minLength || 0) || value.length > (schema.maxLength || Infinity)) bad("expected a non-empty string within the documented length limit.");
    if (schema.enum && !schema.enum.includes(value)) bad(`must be one of: ${schema.enum.join(", ")}.`);
  } else if (schema.type === "integer") {
    if (!Number.isSafeInteger(value) || value < schema.minimum || value > schema.maximum) bad(`expected an integer from ${schema.minimum} to ${schema.maximum}.`);
  }
}

export async function callControlTool(name, input, client) {
  const definition = CONTROL_TOOLS.find(item => item.name === name);
  if (!definition) throw new ControlClientError("UNKNOWN_TOOL", "Unknown AporiaX control tool.");
  validate(input, definition.inputSchema);
  return definition.invoke(input, client);
}
