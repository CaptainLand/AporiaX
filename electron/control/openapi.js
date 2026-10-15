import { CONTROL_API_PATH, CONTROL_API_VERSION, MAX_LIMITS, snakeCase } from "./contracts.js";
import { LOCAL_CONTROL_RATE_LIMITS } from "./server.js";

const ref = name => ({ $ref: `#/components/schemas/${name}` });
const text = (maxLength, description) => ({ type: "string", ...(maxLength ? { maxLength } : {}), ...(description ? { description } : {}) });
const object = (properties, required = [], additionalProperties = false) => ({ type: "object", properties,
  ...(required.length ? { required } : {}), additionalProperties });
const array = items => ({ type: "array", items });
const timestamp = { type: "string", format: "date-time" };
const nullableTimestamp = { type: ["string", "null"], format: "date-time" };
const status = { type: "string", enum: ["queued", "starting", "running", "paused", "waiting_question", "waiting_approval", "cancelling", "completed", "partial", "blocked", "failed", "interrupted", "cancelled"] };
const id = { type: "string", minLength: 1, maxLength: 100 };
const pathParameter = (name, description, maximum = 100) => ({ name, in: "path", required: true, description,
  schema: { type: "string", minLength: 1, maxLength: maximum } });
const runParameter = pathParameter("run_id", "A run ID returned by this client's create or list operation.");
const queryInteger = (name, description, minimum, maximum, defaultValue) => ({ name, in: "query", required: false, description,
  schema: { type: "integer", minimum, maximum, default: defaultValue } });
const jsonResponse = (description, schema) => ({ description, content: { "application/json": { schema } } });
const requestBody = schema => ({ required: true, content: { "application/json": { schema } } });
const commonResponses = {
  "400": { $ref: "#/components/responses/InvalidRequest" },
  "401": { $ref: "#/components/responses/Unauthorized" },
  "403": { $ref: "#/components/responses/Forbidden" },
  "404": { $ref: "#/components/responses/NotFound" },
  "409": { $ref: "#/components/responses/Conflict" },
  "413": { $ref: "#/components/responses/TooLarge" },
  "429": { $ref: "#/components/responses/RateLimited" },
  "500": { $ref: "#/components/responses/InternalError" },
  "503": { $ref: "#/components/responses/Disabled" },
};
const operation = (operationId, summary, responseSchema, { description = "", parameters = [], input = null, accepted = false, tag = "Runs" } = {}) => ({
  operationId, summary, ...(description ? { description } : {}), tags: [tag],
  ...(parameters.length ? { parameters } : {}), ...(input ? { requestBody: requestBody(input) } : {}),
  responses: { [accepted ? "202" : "200"]: jsonResponse(accepted ? "Task request persisted. Poll the returned run_id; the task can still be queued." : "Request succeeded.", responseSchema),
    ...commonResponses, ...(input ? { "415": { $ref: "#/components/responses/UnsupportedMediaType" } } : {}) },
});

/** Build a token-free, OpenAPI 3.1 contract. Return it directly: reserved OpenAPI keys are camelCase. */
export function createLocalControlOpenApi({ baseUrl = null } = {}) {
  const limitProperties = Object.fromEntries(Object.entries(snakeCase(MAX_LIMITS)).map(([name, maximum]) => [name, {
    type: "integer", minimum: name === "max_duration_seconds" ? 1 : 0, maximum,
    description: name === "max_duration_seconds"
      ? "Wall-clock deadline in seconds, including preparation and waits. Cannot exceed the desktop client grant."
      : "Whole-task limit shared by delegated agents. Zero disables this activity. Cannot exceed the desktop client grant.",
  }]));
  const artifact = object({
    id: text(160), artifact_id: text(160), name: text(), mime_type: text(), bytes: { type: "integer", minimum: 0 },
    source: { type: "string", enum: ["virtual", "file"] }, changed: {}, truncated: { type: "boolean" },
  }, ["id", "artifact_id", "name", "mime_type", "bytes", "source"]);
  const schemas = {
    ErrorResponse: object({ error: object({ code: text(), message: text(), details: {} }, ["code", "message"]) }, ["error"]),
    Limits: { ...object(limitProperties), description: "Omitted values inherit the authenticated client's grant. Requests may only reduce limits." },
    RunStatus: status,
    Meta: object({ api_version: { type: "integer", const: CONTROL_API_VERSION }, name: text(), instance_id: text(), client_id: id,
      openapi_path: { type: "string", const: `${CONTROL_API_PATH}/openapi` }, capabilities: { type: "object", additionalProperties: true }, limits: ref("Limits"),
    }, ["api_version", "name", "instance_id", "client_id", "openapi_path", "capabilities", "limits"]),
    Workspace: object({ id, label: text(200), path: text(), created_at: timestamp }, ["id", "label", "path", "created_at"]),
    Workspaces: object({ workspaces: array(ref("Workspace")) }, ["workspaces"]),
    Profile: object({ id: { type: "string", enum: ["review", "workspace"] }, name: text(),
      permission_profile: { type: "string", enum: ["read_only", "workspace_edit"] },
    }, ["id", "name", "permission_profile"]),
    Profiles: object({ profiles: array(ref("Profile")) }, ["profiles"]),
    Model: object({ id: text(200), name: text() }, ["id", "name"]),
    Provider: object({ id: text(200), name: text(), models: array(ref("Model")), available: { type: "boolean" } }, ["id", "name", "models"]),
    Providers: object({ providers: array(ref("Provider")) }, ["providers"]),
    RunCreateInput: object({
      instruction: { type: "string", minLength: 1, maxLength: 60000, description: "Task instructions. Whitespace-only strings are rejected." },
      workspace_id: { ...id, description: "A workspace granted to this client and returned by GET /workspaces." },
      profile: { type: "string", enum: ["review", "workspace"], description: "Must be one of the profiles granted in the desktop." },
      provider_id: text(200, "Optional granted provider ID. If omitted, use the first available granted provider."),
      model_id: text(200, "Optional model ID from the selected provider and within the client grant. If omitted, use the first available granted model."),
      idempotency_key: { type: "string", minLength: 1, maxLength: 160, pattern: "^[A-Za-z0-9_.:-]+$",
        description: "Required stable key for this logical request. Reuse it with the same input after a lost response. A different input using the same key returns 409." },
      limits: ref("Limits"),
    }, ["instruction", "workspace_id", "profile", "idempotency_key"]),
    Run: object({
      run_id: id, task_id: id, client_id: id, client_name: text(100), workspace_id: id, workspace_path: text(),
      execution_workspace_path: text(), execution_workspace: { type: "object", additionalProperties: true },
      profile: { type: "string", enum: ["review", "workspace"] }, instruction: text(60000), provider_id: text(200), model_id: text(200),
      limits: ref("Limits"), status: ref("RunStatus"), created_at: timestamp, updated_at: timestamp,
      started_at: nullableTimestamp, completed_at: nullableTimestamp, deadline_at: timestamp,
      cancel_requested_at: timestamp, cancellation_reason: text(), error: text(), control_usage: { type: "object", additionalProperties: true },
      idempotent_replay: { type: "boolean" },
    }, ["run_id", "task_id", "client_id", "workspace_id", "profile", "instruction", "status", "created_at", "updated_at", "limits"], true),
    RunPage: object({ runs: array(ref("Run")), next_before: { type: ["string", "null"] }, has_more: { type: "boolean" } }, ["runs", "next_before", "has_more"]),
    ResultStorage: object({ version: { type: "integer", minimum: 1 }, truncated: { type: "boolean" }, redacted: { type: "boolean" }, max_bytes: { type: "integer", minimum: 1 } },
      [], true),
    DeliveryResult: object({ status: ref("RunStatus"), content: text(), summary: text(), changes: array({}), workspace_changes: {}, steps: array({}),
      usage: {}, cumulative_usage: {}, usage_history_complete: { type: "boolean" }, artifacts: array({}),
      error: {}, error_details: {}, warnings: {}, risks: {}, verification: {}, self_check: {}, acceptance: {}, workspace: {}, persistence: {}, control_usage: {},
      result_storage: ref("ResultStorage"), truncated: { type: "boolean" },
    }, ["status"], true),
    RunResult: object({ run_id: id, status: ref("RunStatus"), result: { anyOf: [ref("DeliveryResult"), { type: "null" }],
      description: "null until the final result and complete artifact index commit atomically. A finished task may report partial, blocked, failed, interrupted, or cancelled. Inspect self_check and result_storage before interpreting the delivery." },
      artifacts: array(ref("Artifact")),
    }, ["run_id", "status", "result", "artifacts"]),
    Event: object({ seq: { type: "integer", minimum: 1 }, at: timestamp, type: text(), payload: {},
    }, ["seq", "at", "type", "payload"]),
    EventPage: object({ run_id: id, events: array(ref("Event")), next_seq: { type: "integer", minimum: 0 }, has_more: { type: "boolean" } },
      ["run_id", "events", "next_seq", "has_more"]),
    Agent: object({ id: text(), name: text(), role: text(), status: text(), last_event_type: text(), updated_at: timestamp },
      ["id", "name", "role", "status", "last_event_type", "updated_at"]),
    Agents: object({ agents: array(ref("Agent")) }, ["agents"]),
    QuestionOption: object({ id: text(100), label: text(100), description: text(250), recommended: { type: "boolean" } }, ["id", "label"], true),
    Question: object({ id, question: text(500), reason: text(500), options: array(ref("QuestionOption")), status: text(),
      answer: {}, created_at: timestamp, answered_at: timestamp,
    }, ["id", "question", "status"], true),
    Questions: object({ questions: array(ref("Question")) }, ["questions"]),
    Approval: object({ approval_id: id, run_id: id, approval: { type: "object", additionalProperties: true,
      description: "Public pending approval details, such as kind, tool, title, command, cwd, and reason. This API cannot submit an approval decision." },
    }, ["approval_id", "run_id", "approval"]),
    Approvals: object({ approvals: array(ref("Approval")) }, ["approvals"]),
    Artifact: artifact,
    Artifacts: object({ artifacts: array(ref("Artifact")) }, ["artifacts"]),
    ArtifactPage: object({ artifact_id: text(160), name: text(), mime_type: text(), encoding: { type: "string", const: "base64" },
      content: { type: "string", contentEncoding: "base64", description: "Exact bytes encoded in base64. Decode pages to bytes and concatenate them before decoding UTF-8 text." },
      offset: { type: "integer", minimum: 0 }, next_offset: { type: "integer", minimum: 0 }, total_bytes: { type: "integer", minimum: 0 }, has_more: { type: "boolean" },
    }, ["artifact_id", "name", "mime_type", "encoding", "content", "offset", "next_offset", "total_bytes", "has_more"]),
    EmptyInput: object({}),
    MessageInput: object({ content: { type: "string", minLength: 1, maxLength: 60000 } }, ["content"]),
    QuestionAnswerInput: object({ answer: { oneOf: [
      { type: "string", minLength: 1, maxLength: 4000 },
      object({ text: { type: "string", minLength: 1, maxLength: 4000 } }, ["text"]),
      object({ option_id: { type: "string", minLength: 1, maxLength: 100 } }, ["option_id"]),
    ] } }, ["answer"]),
    ControlAccepted: object({ ok: { type: "boolean", const: true }, status: ref("RunStatus") }, ["ok"]),
    MessageAccepted: object({ ok: { type: "boolean", const: true }, message_id: text() }, ["ok", "message_id"]),
    AnswerAccepted: object({ ok: { type: "boolean", const: true }, accepted: { type: "boolean" }, already_answered: { type: "boolean" } }, ["ok"], true),
    OpenApiDocument: { type: "object", required: ["openapi", "info", "paths", "components"], additionalProperties: true },
  };
  const route = suffix => `${CONTROL_API_PATH}${suffix}`;
  const paths = {
    [route("/meta")]: { get: operation("getLocalControlMeta", "Read this client's API capabilities", ref("Meta"), { tag: "Discovery" }) },
    [route("/openapi")]: { get: operation("getLocalControlOpenApi", "Read this authenticated OpenAPI contract", ref("OpenApiDocument"), { tag: "Discovery" }) },
    [route("/workspaces")]: { get: operation("listGrantedWorkspaces", "List granted workspaces", ref("Workspaces"), { tag: "Discovery" }) },
    [route("/profiles")]: { get: operation("listGrantedProfiles", "List granted agent profiles", ref("Profiles"), { tag: "Discovery" }) },
    [route("/providers")]: { get: operation("listGrantedProviders", "List granted providers and models without credentials", ref("Providers"), { tag: "Discovery" }) },
    [route("/runs")]: {
      get: operation("listRuns", "List this client's durable runs", ref("RunPage"), { parameters: [
        queryInteger("limit", "Maximum runs in this page.", 1, 200, 100),
        { name: "before", in: "query", required: false, schema: id, description: "Use next_before from the previous page. The referenced run must belong to this client." },
      ], description: "Newest creation first. Use next_before while has_more is true; run status updates do not reorder this cursor." }),
      post: operation("createRun", "Persist and queue a task", ref("Run"), { input: ref("RunCreateInput"), accepted: true,
        description: "Returns before model execution. The server assigns run and task IDs, derives permissions from the desktop grant, and persists the request before execution. Repeated identical idempotency keys return the original run with idempotent_replay=true, including after provider defaults change. A client disconnect does not cancel a run." }),
    },
    [route("/runs/{run_id}")]: { get: operation("getRun", "Read a run's durable status", ref("Run"), { parameters: [runParameter] }) },
    [route("/runs/{run_id}/result")]: { get: operation("getRunResult", "Read the durable final result and artifact index", ref("RunResult"), { parameters: [runParameter],
      description: "A running task returns result=null. Inspect status and the result's verification and risk fields before treating the task as successful." }) },
    [route("/runs/{run_id}/events")]: { get: operation("readRunEvents", "Read durable events after an exclusive sequence cursor", ref("EventPage"), { parameters: [runParameter,
      queryInteger("after_seq", "Exclusive durable cursor. Start at 0; use next_seq from every response.", 0, Number.MAX_SAFE_INTEGER, 0),
      queryInteger("limit", "Maximum events. Reduce this value if a page exceeds the HTTP response byte limit.", 1, 1000, 200),
    ], description: "Events are returned in ascending sequence order without dropping the middle of a backlog. Sequences can have gaps because other runs share the database counter. Each payload is bounded and may include explicit truncation metadata." }) },
    [route("/runs/{run_id}/agents")]: { get: operation("listRunAgents", "List agents observed in this run", ref("Agents"), { parameters: [runParameter] }) },
    [route("/runs/{run_id}/questions")]: { get: operation("listRunQuestions", "Read clarification questions and answers", ref("Questions"), { parameters: [runParameter] }) },
    [route("/runs/{run_id}/approvals")]: { get: operation("listRunApprovals", "Read pending approvals for desktop review", ref("Approvals"), { parameters: [runParameter],
      description: "Read only. A normal client token cannot approve tools, even when it created the task. The human user answers approvals in AporiaX desktop." }) },
    [route("/runs/{run_id}/artifacts")]: { get: operation("listRunArtifacts", "List artifacts registered to this run", ref("Artifacts"), { tag: "Artifacts", parameters: [runParameter] }) },
    [route("/runs/{run_id}/artifacts/{artifact_id}")]: { get: operation("readRunArtifact", "Read a registered artifact page", ref("ArtifactPage"), { tag: "Artifacts", parameters: [runParameter,
      pathParameter("artifact_id", "An artifact ID returned by this run's artifact index. Filesystem paths are not accepted.", 160),
      queryInteger("offset", "Byte offset. Use next_offset while has_more is true.", 0, 64 * 1024 * 1024, 0),
      queryInteger("limit", "Maximum bytes to return before base64 encoding.", 1, 65536, 65536),
    ], description: "The API serves only virtual result/report artifacts and registered files under the trusted execution workspace. File path or identity changes since completion return 409. Byte pages are base64 so multibyte text can be reconstructed exactly." }) },
    [route("/runs/{run_id}/messages")]: { post: operation("sendRunMessage", "Send follow-up guidance to an active run", ref("MessageAccepted"), { tag: "Control", parameters: [runParameter], input: ref("MessageInput"),
      description: "Guidance does not change the client grant or approve a tool. Queued, preparing, and finished runs cannot accept messages." }) },
    [route("/runs/{run_id}/questions/{question_id}/answer")]: { post: operation("answerRunQuestion", "Answer a clarification question", ref("AnswerAccepted"), { tag: "Control",
      parameters: [runParameter, pathParameter("question_id", "A question ID returned by this run's questions endpoint.")], input: ref("QuestionAnswerInput"),
      description: "Accepts free text or a listed option_id. The answer supplements task intent and never grants command or tool permissions." }) },
  };
  for (const [action, summary, description] of [
    ["pause", "Pause an active run", "Pauses at a runtime control checkpoint. Queued or preparing runs return 409."],
    ["resume", "Resume a paused active run", "Resumes the active runtime without creating a new task or refreshing its limits. Finished or interrupted-after-restart runs require an explicitly created follow-up task."],
    ["cancel", "Cancel a queued or active run", "Queued runs are cancelled before execution. Active cancellation is cooperative and may first return cancelling. Repeating cancellation for a finished run returns its existing status."],
  ]) paths[route(`/runs/{run_id}/${action}`)] = { post: operation(`${action}Run`, summary, ref("ControlAccepted"), {
    tag: "Control", parameters: [runParameter], input: ref("EmptyInput"), description,
  }) };

  const errors = {
    InvalidRequest: "Invalid JSON, unknown input fields, invalid query, or limits outside the granted range.",
    Unauthorized: "Missing, invalid, or revoked client Bearer token.",
    Forbidden: "The workspace, profile, provider, or model was not granted; browser Origin or non-loopback Host is also rejected.",
    NotFound: "Unknown route or resource. Runs owned by a different client also return 404.",
    Conflict: "An idempotency key was reused with different input, the run is not in an actionable state, a question is stale, or an artifact changed.",
    TooLarge: "The JSON request exceeds 128 KiB or the response exceeds 6 MiB. Reduce event page size for oversized responses.",
    UnsupportedMediaType: "POST requests require Content-Type: application/json.",
    RateLimited: "Fixed one-minute windows: 240 requests per client, 2400 total requests, and 240 unauthenticated attempts by default. Invalid attempts do not consume authenticated clients' individual buckets. error.details.scope identifies the limited bucket.",
    InternalError: "The local operation could not complete. Inspect desktop status before retrying a mutation.",
    Disabled: "The desktop local control service is disabled or shutting down.",
  };
  return {
    openapi: "3.1.0", jsonSchemaDialect: "https://json-schema.org/draft/2020-12/schema",
    info: { title: "AporiaX Local Control API", version: String(CONTROL_API_VERSION),
      description: "Authenticated, loopback-only task control for external agent harnesses. Pair clients in the desktop. All application request and response fields use snake_case. POST bodies reject unknown fields. This contract itself retains standard OpenAPI field names. Requests with any Origin header are rejected; use a local non-browser HTTP client or the bundled MCP stdio adapter." },
    servers: [{ url: typeof baseUrl === "string" && /^http:\/\/127\.0\.0\.1:\d+$/.test(baseUrl) ? baseUrl : "/", description: "Current AporiaX instance. Reread the connection discovery file after desktop restarts." }],
    security: [{ ClientBearer: [] }],
    tags: ["Discovery", "Runs", "Control", "Artifacts"].map(name => ({ name })),
    paths,
    components: {
      securitySchemes: { ClientBearer: { type: "http", scheme: "bearer", bearerFormat: "AporiaX client token",
        description: "A per-client credential created in desktop settings. Include Authorization: Bearer <token>. Tokens grant only the configured workspaces, profiles, providers, capabilities, and budgets; they never grant human approval." } },
      schemas,
      responses: Object.fromEntries(Object.entries(errors).map(([name, description]) => [name, {
        ...jsonResponse(description, ref("ErrorResponse")),
        ...(name === "RateLimited" ? { headers: { "Retry-After": { description: "Conservative retry delay in seconds.", schema: { type: "integer", const: 60 } } } } : {}),
      }])),
    },
    "x-aporiax-limits": { max_request_body_bytes: 128 * 1024, max_response_bytes: 6 * 1024 * 1024,
      default_requests_per_minute: { per_client: LOCAL_CONTROL_RATE_LIMITS.client, global: LOCAL_CONTROL_RATE_LIMITS.global, unauthenticated: LOCAL_CONTROL_RATE_LIMITS.unauthenticated } },
  };
}
