import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  CollaborationMailbox,
  approveBuilderPlan,
  compareBuilderHandoffs,
  createCollaborationAudit,
  normalizeBuilderHandoff,
  normalizeCollaborationContract,
} from "../electron/harness/collaboration.js";
import {
  loadProjectInstructionContext,
  runWithCollaborationContext,
} from "../electron/agent-context.js";

const tasks = [
  {
    id: "login",
    title: "Login",
    task: "Implement login",
    role: "builder",
    writeScopes: ["src/login"],
    dependsOn: [],
    contractKeys: ["auth.identifier", "auth.form"],
    approvedPlan: { approach: "Reuse shared form conventions", assumptions: [] },
  },
  {
    id: "register",
    title: "Register",
    task: "Implement registration",
    role: "builder",
    writeScopes: ["src/register"],
    dependsOn: [],
    contractKeys: ["auth.identifier", "auth.form"],
    approvedPlan: { approach: "Reuse shared form conventions", assumptions: [] },
  },
];

const contract = normalizeCollaborationContract(
  {
    title: "Auth contract",
    goal: "Login and registration stay aligned",
    invariants: [
      {
        key: "auth.identifier",
        category: "api",
        value: "identifier:string",
        severity: "must",
      },
      {
        key: "auth.form",
        category: "ui",
        value: "reuse AuthForm/Input/Button",
        severity: "must",
      },
    ],
    sharedFiles: ["src/auth/store.js"],
    acceptance: ["Both flows use identifier"],
  },
  { tasks },
);
assert.match(contract.id, /^contract-/);
assert.equal(contract.ownership.length, 2);
assert.equal(approveBuilderPlan({ contract, tasks }).approved, true);

const colliding = approveBuilderPlan({
  contract: normalizeCollaborationContract(
    {
      invariants: [{ key: "x", value: "1", severity: "must" }],
      sharedFiles: ["src/login/shared.js"],
    },
    { tasks },
  ),
  tasks,
});
assert.equal(colliding.approved, false);
assert(colliding.reasons.some((reason) => reason.includes("owns-shared-file")));

const mailbox = new CollaborationMailbox({ maxMessages: 3 });
mailbox.post({
  from: "login",
  to: "register",
  type: "notice",
  topic: "field-name",
  detail: "Use identifier, not email.",
});
mailbox.post({
  from: "login",
  to: "main",
  type: "question",
  detail: "Main owns the shared auth store update.",
});
assert.equal(mailbox.forTarget("register").length, 1);
assert.equal(mailbox.forTarget("main").length, 1);

const loginHandoff = normalizeBuilderHandoff(
  JSON.stringify({
    summary: "Login complete",
    assumptions: [],
    requiresMain: ["Wire shared auth store"],
    contractAssertions: [
      { key: "auth.identifier", value: "identifier:string", evidence: "src/login/form.js" },
      { key: "auth.form", value: "reuse AuthForm/Input/Button", evidence: "src/login/form.js" },
    ],
    messages: [
      { type: "notice", to: "register", detail: "Login uses the canonical identifier field." },
    ],
  }),
  { task: tasks[0], contract },
);
const registerHandoff = normalizeBuilderHandoff(
  JSON.stringify({
    summary: "Registration complete",
    assumptions: [],
    requiresMain: [],
    contractAssertions: [
      { key: "auth.identifier", value: "identifier:string", evidence: "src/register/form.js" },
      { key: "auth.form", value: "reuse AuthForm/Input/Button", evidence: "src/register/form.js" },
    ],
    messages: [],
  }),
  { task: tasks[1], contract },
);
assert.equal(loginHandoff.structured, true);
assert.equal(
  compareBuilderHandoffs({
    contract,
    tasks,
    handoffs: [
      { id: "login", handoff: loginHandoff },
      { id: "register", handoff: registerHandoff },
    ],
  }).passed,
  true,
);

const conflictingHandoff = normalizeBuilderHandoff(
  JSON.stringify({
    summary: "Registration chose another field",
    contractAssertions: [
      { key: "auth.identifier", value: "email:string", evidence: "src/register/form.js" },
    ],
  }),
  { task: tasks[1], contract },
);
const semanticConflict = compareBuilderHandoffs({
  contract,
  tasks,
  handoffs: [
    { id: "login", handoff: loginHandoff },
    { id: "register", handoff: conflictingHandoff },
  ],
});
assert.equal(semanticConflict.passed, false);
assert(semanticConflict.conflicts.some((item) => item.type === "contract-mismatch"));
assert(semanticConflict.conflicts.some((item) => item.type === "builder-disagreement"));

const audit = createCollaborationAudit();
audit.observe({ type: "collaboration.contract.created", contract });
audit.observe({ type: "collaboration.plan.approved", tasks, reasons: [] });
audit.observe({
  type: "collaboration.semantic.checked",
  result: semanticConflict,
});
assert.equal(audit.snapshot().contract.id, contract.id);
assert.equal(audit.snapshot().approval.approved, true);
assert.equal(audit.snapshot().semanticCheck.passed, false);

const tempWorkspace = await mkdtemp(join(tmpdir(), "aporiax-collaboration-context-"));
try {
  const instructions = await runWithCollaborationContext(
    {
      contract,
      task: tasks[0],
      inbox: mailbox.forTarget("login"),
      handoffs: [{ id: "register", handoff: registerHandoff }],
      semanticCheck: { passed: true, conflicts: [], warnings: [] },
    },
    () => loadProjectInstructionContext(tempWorkspace),
  );
  assert.match(instructions.root.content, /Shared Collaboration Contract/);
  assert.match(instructions.root.content, /auth\.identifier/);
  assert.match(instructions.root.content, /identifier:string/);
} finally {
  await rm(tempWorkspace, { recursive: true, force: true });
}

console.log("harness collaboration smoke: PASS");