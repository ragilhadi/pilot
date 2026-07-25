import { defineTool, PilotError, type ToolDefinition } from "@pilotrun/core";
import * as z from "zod";

export const TodoStatusSchema = z.enum(["pending", "in_progress", "completed"]);

export const TodoItemSchema = z
  .object({
    id: z.string().min(1).max(128),
    content: z
      .string()
      .min(1)
      .max(500)
      .refine(
        (value) => !hasControlCharacter(value),
        "Todo content must be a single line without control characters",
      ),
    status: TodoStatusSchema,
  })
  .strict()
  .readonly();

const TodoCountsSchema = z
  .object({
    total: z.number().int().nonnegative(),
    pending: z.number().int().nonnegative(),
    inProgress: z.number().int().nonnegative(),
    completed: z.number().int().nonnegative(),
  })
  .strict()
  .readonly();

export const TodoWriteInputSchema = z
  .object({
    items: z.array(TodoItemSchema).max(100).readonly(),
  })
  .strict()
  .readonly();

export const TodoListOutputSchema = z
  .object({
    items: z.array(TodoItemSchema).max(100).readonly(),
    counts: TodoCountsSchema,
  })
  .strict()
  .readonly();

export const TodoReadInputSchema = z.object({}).strict().readonly();

export type TodoStatus = z.output<typeof TodoStatusSchema>;
export type TodoItem = z.output<typeof TodoItemSchema>;
export type TodoWriteInput = z.output<typeof TodoWriteInputSchema>;
export type TodoReadInput = z.output<typeof TodoReadInputSchema>;
export type TodoListOutput = z.output<typeof TodoListOutputSchema>;

/** In-session store for the agent's task list, mirroring the change-journal pattern. */
export interface TodoStore {
  list(): readonly TodoItem[];
  replace(items: readonly TodoItem[]): readonly TodoItem[];
}

export class InMemoryTodoStore implements TodoStore {
  #items: readonly TodoItem[] = Object.freeze([]);

  list(): readonly TodoItem[] {
    return this.#items;
  }

  replace(items: readonly TodoItem[]): readonly TodoItem[] {
    this.#items = Object.freeze(items.map((item) => Object.freeze({ ...item })));
    return this.#items;
  }
}

export class TodoToolError extends PilotError {
  constructor(message: string, metadata: Readonly<Record<string, unknown>>) {
    super({
      code: "PILOT_TODO_DUPLICATE_ID",
      message,
      safeMessage: "Each todo item must have a unique id",
      metadata,
    });
  }
}

export interface TodoTools {
  readonly todoWrite: ToolDefinition<typeof TodoWriteInputSchema, typeof TodoListOutputSchema>;
  readonly todoRead: ToolDefinition<typeof TodoReadInputSchema, typeof TodoListOutputSchema>;
}

export function createTodoTools(store: TodoStore): TodoTools {
  return Object.freeze({
    todoWrite: createTodoWriteTool(store),
    todoRead: createTodoReadTool(store),
  });
}

export function createTodoWriteTool(
  store: TodoStore,
): ToolDefinition<typeof TodoWriteInputSchema, typeof TodoListOutputSchema> {
  return defineTool({
    name: "todo_write",
    description:
      "Replace the agent's task list for this session. Pass the complete set of items each time; " +
      "the previous list is overwritten. Use it to plan and track progress on multi-step work: " +
      "mark exactly one item in_progress while working on it, and completed once it is done.",
    inputSchema: TodoWriteInputSchema,
    outputSchema: TodoListOutputSchema,
    // Bookkeeping only: no workspace, network, or system side effects, so it is
    // permission-free (read-only) even though it mutates in-session state.
    metadata: {
      risk: "read-only",
      concurrency: "exclusive",
      timeoutMs: 5_000,
      maxOutputBytes: 100_000,
      requiredPermissions: [],
    },
    execute: async (input) => {
      const items = assertUniqueIds(input.items);
      const stored = store.replace(items);
      const output = toOutput(stored);
      return { output, metadata: { changed: true, ...output.counts } };
    },
  });
}

export function createTodoReadTool(
  store: TodoStore,
): ToolDefinition<typeof TodoReadInputSchema, typeof TodoListOutputSchema> {
  return defineTool({
    name: "todo_read",
    description:
      "Return the agent's current task list for this session. Useful for re-orienting after a long " +
      "stretch of work or when the earlier list may have scrolled out of context.",
    inputSchema: TodoReadInputSchema,
    outputSchema: TodoListOutputSchema,
    metadata: {
      risk: "read-only",
      concurrency: "parallel-safe",
      timeoutMs: 5_000,
      maxOutputBytes: 100_000,
      requiredPermissions: [],
    },
    execute: async () => {
      const output = toOutput(store.list());
      return { output, metadata: { ...output.counts } };
    },
  });
}

function assertUniqueIds(items: readonly TodoItem[]): readonly TodoItem[] {
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.id)) {
      throw new TodoToolError(`Duplicate todo id ${item.id}`, { id: item.id });
    }
    seen.add(item.id);
  }
  return items;
}

function toOutput(items: readonly TodoItem[]): TodoListOutput {
  return Object.freeze({
    items: Object.freeze([...items]),
    counts: Object.freeze({
      total: items.length,
      pending: items.filter((item) => item.status === "pending").length,
      inProgress: items.filter((item) => item.status === "in_progress").length,
      completed: items.filter((item) => item.status === "completed").length,
    }),
  });
}

/**
 * Control characters (C0/C1) and the Unicode line/paragraph separators. Todo
 * items are short single-line labels, so rejecting these keeps a rendered list
 * safe and on one line without mutating the model's text.
 */
function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      codePoint === 0x2028 ||
      codePoint === 0x2029
    ) {
      return true;
    }
  }
  return false;
}
