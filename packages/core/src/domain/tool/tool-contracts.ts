import * as z from "zod";
import { JsonValueSchema, type JsonObject, type JsonValue } from "../../shared/json.js";
import type { ModelToolDefinition } from "../model/index.js";
import { ToolContractError } from "./tool-contract-error.js";
import type { AnyToolSchema, ToolDefinition, ToolSchemaOutput } from "./tool.types.js";

export function parseToolInput<Tool extends ToolDefinition>(
  tool: Tool,
  input: unknown,
): z.output<Tool["inputSchema"]> {
  const result = tool.inputSchema.safeParse(input);
  if (!result.success) {
    throw new ToolContractError(
      "PILOT_TOOL_INPUT_INVALID",
      tool.name,
      "input",
      `Input validation failed for tool ${tool.name}`,
      result.error,
    );
  }
  return result.data as z.output<Tool["inputSchema"]>;
}

export function parseToolOutput<Tool extends ToolDefinition>(
  tool: Tool,
  output: unknown,
): ToolSchemaOutput<Tool["outputSchema"]> {
  if (tool.outputSchema === undefined) {
    const result = JsonValueSchema.safeParse(output);
    if (!result.success) {
      throw new ToolContractError(
        "PILOT_TOOL_OUTPUT_INVALID",
        tool.name,
        "output",
        `Output validation failed for tool ${tool.name}`,
        result.error,
      );
    }
    return result.data as ToolSchemaOutput<Tool["outputSchema"]>;
  }
  const result = tool.outputSchema.safeParse(output);
  if (!result.success) {
    throw new ToolContractError(
      "PILOT_TOOL_OUTPUT_INVALID",
      tool.name,
      "output",
      `Output validation failed for tool ${tool.name}`,
      result.error,
    );
  }
  return result.data as ToolSchemaOutput<Tool["outputSchema"]>;
}

export function toolToModelDefinition(tool: ToolDefinition): ModelToolDefinition {
  return Object.freeze({
    name: tool.name,
    description: tool.description,
    inputSchema: schemaToJsonObject(tool.name, tool.inputSchema, "input"),
    ...(tool.outputSchema === undefined
      ? {}
      : { outputSchema: schemaToJsonObject(tool.name, tool.outputSchema, "output") }),
  });
}

function schemaToJsonObject(
  toolName: string,
  schema: AnyToolSchema,
  direction: "input" | "output",
): JsonObject {
  try {
    const converted: unknown = z.toJSONSchema(schema, {
      target: "draft-7",
      io: direction === "input" ? "input" : "output",
    });
    const parsed = JsonValueSchema.safeParse(converted);
    if (!parsed.success || !isJsonObject(parsed.data) || parsed.data.type !== "object") {
      throw new Error(`${direction} schema must produce an object JSON Schema`);
    }
    return parsed.data;
  } catch (error) {
    throw new ToolContractError(
      "PILOT_TOOL_SCHEMA_UNSUPPORTED",
      toolName,
      "schema",
      `The ${direction} schema for tool ${toolName} cannot be represented as object JSON Schema`,
      error,
    );
  }
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
