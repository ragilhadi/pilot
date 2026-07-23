import { defineTool, type ToolExecutionContext, ToolContractError } from "@pilot/core";
import { describe, expect, it } from "vitest";
import * as z from "zod";
import { ToolNotFoundError, ToolRegistrationConflictError, ToolRegistry } from "../src/index.js";

const metadata = {
  risk: "read-only",
  concurrency: "parallel-safe",
  timeoutMs: 5_000,
  maxOutputBytes: 64_000,
  requiredPermissions: ["workspace.read"],
} as const;

function listFilesTool() {
  return defineTool({
    name: "list_files",
    description: "List files below a workspace-relative directory",
    inputSchema: z
      .object({
        path: z.string().min(1),
        limit: z.number().int().positive().max(1_000).default(100),
      })
      .strict(),
    outputSchema: z
      .object({
        files: z.array(z.string()).readonly(),
        truncated: z.boolean(),
      })
      .strict(),
    metadata,
    execute: async (input, _context: ToolExecutionContext) => ({
      output: { files: [input.path], truncated: false },
    }),
  });
}

describe("defineTool and ToolRegistry", () => {
  it("produces stable model-facing JSON Schema and sorted registry output", () => {
    const second = defineTool({
      name: "read_file",
      description: "Read a file",
      inputSchema: z.object({ path: z.string() }).strict(),
      metadata,
      execute: async () => ({ output: { content: "example" } }),
    });
    const registry = new ToolRegistry([second, listFilesTool()]);

    expect(registry.modelDefinitions().map(({ name }) => name)).toEqual([
      "list_files",
      "read_file",
    ]);
    expect(registry.resolve("list_files").modelDefinition).toMatchObject({
      name: "list_files",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", minLength: 1 },
          limit: { type: "integer", maximum: 1_000, default: 100 },
        },
        required: ["path"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: { files: { type: "array" }, truncated: { type: "boolean" } },
        required: ["files", "truncated"],
        additionalProperties: false,
      },
    });
    expect(Object.isFrozen(registry.resolve("list_files"))).toBe(true);
    expect(Object.isFrozen(listFilesTool().metadata)).toBe(true);
  });

  it("parses defaults and validates output at the registry boundary", () => {
    const registry = new ToolRegistry([listFilesTool()]);

    expect(registry.parseInput("list_files", { path: "src" })).toEqual({
      path: "src",
      limit: 100,
    });
    expect(
      registry.parseOutput("list_files", { files: ["src/index.ts"], truncated: false }),
    ).toEqual({ files: ["src/index.ts"], truncated: false });
  });

  it("rejects malformed model input and implementation output with safe typed errors", () => {
    const registry = new ToolRegistry([listFilesTool()]);

    expect(() => registry.parseInput("list_files", { path: "", surprise: true })).toThrowError(
      expect.objectContaining({
        code: "PILOT_TOOL_INPUT_INVALID",
        violation: "input",
      }),
    );
    expect(() => registry.parseOutput("list_files", { files: "not-an-array" })).toThrowError(
      expect.objectContaining({
        code: "PILOT_TOOL_OUTPUT_INVALID",
        violation: "output",
      }),
    );
  });

  it("rejects duplicate and missing tool names explicitly", () => {
    const tool = listFilesTool();
    const registry = new ToolRegistry([tool]);

    expect(() => registry.register(tool)).toThrow(ToolRegistrationConflictError);
    expect(() => registry.resolve("missing_tool")).toThrow(ToolNotFoundError);
  });

  it("rejects schemas that cannot be represented as object tool contracts", () => {
    const invalid = defineTool({
      name: "invalid_tool",
      description: "Invalid scalar input",
      inputSchema: z.string(),
      metadata,
      execute: async (input) => ({ output: input }),
    });

    expect(() => new ToolRegistry([invalid])).toThrowError(
      expect.objectContaining({
        code: "PILOT_TOOL_SCHEMA_UNSUPPORTED",
        violation: "schema",
      }),
    );
    expect(() => new ToolRegistry([invalid])).toThrow(ToolContractError);
  });
});
