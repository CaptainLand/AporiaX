// Keep the live assistant id stable for completion, recovery and tool events.
export function splitSteeredReply(tasks, run, event) {
  const ids = new Set(event.messageIds || []);
  return tasks.map((task) => {
    if (task.id !== run.taskId) return task;
    const active = task.messages.find((message) => message.id === run.assistantId);
    const applied = task.messages.filter((message) => ids.has(message.id) && message.steeringStatus !== "applied");
    if (!active || !applied.length) return task;
    const last = applied.at(-1);
    const archiveId = active.id + "-before-" + last.id;
    const visible = Boolean(active.content?.trim() || active.progressUpdates?.length);
    const messages = [];
    for (const message of task.messages) {
      if (message.id === active.id) {
        if (visible) messages.push({
          id: archiveId, role: "assistant", status: "completed", content: active.content || "",
          progressUpdates: active.progressUpdates || [], createdAt: active.createdAt,
          isSteeringSegment: true,
        });
        continue;
      }
      messages.push(ids.has(message.id) ? { ...message, steeringStatus: "applied", queued: false } : message);
      if (message.id === last.id) messages.push({
        ...active, content: "", progressUpdates: [],
        // Run metadata and sourceUserId deliberately remain attached to the original turn.
        steeringReplyTo: last.id,
      });
    }
    return { ...task, messages };
  });
}
