import { runId, toolCallId } from "@pilotrun/core";
import { describe, expect, it } from "vitest";
import { createTodoTools, InMemoryTodoStore, TodoItemSchema } from "../src/index.js";

describe("todo tools", () => {
  it("writes a task list, stores it, and returns status counts", async () => {
    const store = new InMemoryTodoStore();
    const { todoWrite } = createTodoTools(store);

    const result = await todoWrite.execute(
      {
        items: [
          { id: "1", content: "Explore the codebase", status: "completed" },
          { id: "2", content: "Implement the tool", status: "in_progress" },
          { id: "3", content: "Write tests", status: "pending" },
        ],
      },
      context(),
    );

    expect(result.output.counts).toEqual({ total: 3, pending: 1, inProgress: 1, completed: 1 });
    expect(result.output.items.map((item) => item.id)).toEqual(["1", "2", "3"]);
    expect(store.list().map((item) => item.status)).toEqual([
      "completed",
      "in_progress",
      "pending",
    ]);
    expect(result.metadata).toMatchObject({ changed: true, total: 3, inProgress: 1 });
  });

  it("overwrites the previous list on each write", async () => {
    const store = new InMemoryTodoStore();
    const { todoWrite } = createTodoTools(store);

    await todoWrite.execute(
      { items: [{ id: "1", content: "First", status: "pending" }] },
      context(),
    );
    const result = await todoWrite.execute(
      {
        items: [
          { id: "a", content: "Replaced", status: "completed" },
          { id: "b", content: "New", status: "pending" },
        ],
      },
      context(),
    );

    expect(result.output.items.map((item) => item.id)).toEqual(["a", "b"]);
    expect(store.list()).toHaveLength(2);
  });

  it("reads back the stored list and reflects a cleared list", async () => {
    const store = new InMemoryTodoStore();
    const { todoWrite, todoRead } = createTodoTools(store);

    const empty = await todoRead.execute({}, context());
    expect(empty.output).toEqual({
      items: [],
      counts: { total: 0, pending: 0, inProgress: 0, completed: 0 },
    });

    await todoWrite.execute(
      { items: [{ id: "1", content: "Only task", status: "in_progress" }] },
      context(),
    );
    const populated = await todoRead.execute({}, context());
    expect(populated.output.items).toEqual([
      { id: "1", content: "Only task", status: "in_progress" },
    ]);

    await todoWrite.execute({ items: [] }, context());
    const cleared = await todoRead.execute({}, context());
    expect(cleared.output.counts.total).toBe(0);
  });

  it("rejects duplicate ids and leaves the stored list unchanged", async () => {
    const store = new InMemoryTodoStore();
    store.replace([{ id: "keep", content: "Existing", status: "pending" }]);
    const { todoWrite } = createTodoTools(store);

    await expect(
      todoWrite.execute(
        {
          items: [
            { id: "dup", content: "One", status: "pending" },
            { id: "dup", content: "Two", status: "pending" },
          ],
        },
        context(),
      ),
    ).rejects.toMatchObject({ code: "PILOT_TODO_DUPLICATE_ID", metadata: { id: "dup" } });
    expect(store.list()).toEqual([{ id: "keep", content: "Existing", status: "pending" }]);
  });

  it("does not require any permission and is classified read-only", () => {
    const { todoWrite, todoRead } = createTodoTools(new InMemoryTodoStore());
    for (const tool of [todoWrite, todoRead]) {
      expect(tool.metadata.risk).toBe("read-only");
      expect(tool.metadata.requiredPermissions).toEqual([]);
    }
    expect(todoWrite.metadata.concurrency).toBe("exclusive");
    expect(todoRead.metadata.concurrency).toBe("parallel-safe");
  });

  it("rejects model-facing input that violates the schema", () => {
    const { todoWrite } = createTodoTools(new InMemoryTodoStore());

    // Unknown status.
    expect(() =>
      todoWrite.inputSchema.parse({ items: [{ id: "1", content: "x", status: "blocked" }] }),
    ).toThrow();
    // Empty content.
    expect(() =>
      todoWrite.inputSchema.parse({ items: [{ id: "1", content: "", status: "pending" }] }),
    ).toThrow();
    // Control characters in content are rejected.
    expect(() =>
      todoWrite.inputSchema.parse({ items: [{ id: "1", content: "a\nb", status: "pending" }] }),
    ).toThrow();
    // Extra keys on an item.
    expect(() =>
      TodoItemSchema.parse({ id: "1", content: "x", status: "pending", priority: "high" }),
    ).toThrow();
  });
});

function context() {
  return {
    runId: runId("run-todo"),
    callId: toolCallId("call-todo"),
    signal: new AbortController().signal,
  };
}
