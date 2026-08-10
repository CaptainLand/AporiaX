import { randomUUID } from "node:crypto";

const TERMINAL_STATES = new Set(["completed", "failed", "cancelled"]);

export class HarnessSessionStore {
  #sessions = new Map();
  #eventBus;

  constructor({ eventBus = null } = {}) {
    this.#eventBus = eventBus;
  }

  create(metadata = {}) {
    const id = String(metadata.id || randomUUID());
    if (this.#sessions.has(id)) throw new Error(`Session already exists: ${id}`);
    const now = new Date().toISOString();
    const session = {
      id,
      state: "created",
      createdAt: now,
      updatedAt: now,
      metadata: { ...metadata, id: undefined },
      result: null,
      error: null,
    };
    this.#sessions.set(id, session);
    this.#eventBus?.emit({ type: "session.created", sessionId: id, metadata: session.metadata });
    return { ...session, metadata: { ...session.metadata } };
  }

  transition(id, nextState, detail = {}) {
    const session = this.#sessions.get(String(id));
    if (!session) throw new Error(`Unknown session: ${id}`);
    if (TERMINAL_STATES.has(session.state)) {
      throw new Error(`Session ${id} is already terminal: ${session.state}`);
    }
    session.state = String(nextState || "running");
    session.updatedAt = new Date().toISOString();
    if ("result" in detail) session.result = detail.result;
    if ("error" in detail) session.error = detail.error;
    this.#eventBus?.emit({
      type: `session.${session.state}`,
      sessionId: session.id,
      ...detail,
    });
    return this.get(id);
  }

  get(id) {
    const session = this.#sessions.get(String(id));
    return session ? { ...session, metadata: { ...session.metadata } } : null;
  }

  list() {
    return [...this.#sessions.values()].map((session) => ({
      ...session,
      metadata: { ...session.metadata },
    }));
  }
}
