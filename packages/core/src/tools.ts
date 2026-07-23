import * as z from "zod";
import type { RunId, ToolCallId } from "./brand.js";
import { JsonValueSchema, type JsonObject, type JsonValue } from "./messages.js";
import type { ModelToolDefinition } from "./models.js";
import type { PermissionAction } from "./permissions.js";
import { PilotError } from "./errors.js";

export const ToolRiskSchema = z.enum([
  "read-only",
  "workspace-write",
  "network",
  "system-change",
  "destructive",
  "unknown",
]);

export const ToolMetadataSchema = z
  .object({
    risk: ToolRiskSchema,
    concurrency: z.enum(["parallel-safe", "exclusive"]),
    timeoutMs: z.number().int().positive(),
    maxOutputBytes: z.number().int().positive(),
    requiredPermissions: z.array(z.string().min(1)).readonly(),
  })
  .strict()
  .readonly();

export type ToolRisk = z.output<typeof ToolRiskSchema>;
export type ToolMetadata = z.output<typeof ToolMetadataSchema>;

export interface ToolExecutionContext {
  readonly runId: RunId;
  readonly callId: ToolCallId;
  readonly signal: AbortSignal;
}

export interface ToolExecutionResult<TOutput> {
  readonly output: TOutput;
  readonly metadata?: JsonObject;
}

export type AnyToolSchema = z.ZodType;
export type ToolSchemaOutput<Schema extends AnyToolSchema | undefined> =
  Schema extends AnyToolSchema ? z.output<Schema> : JsonValue;

export interface ToolDefinition<
  InputSchema extends AnyToolSchema = AnyToolSchema,
  OutputSchema extends AnyToolSchema | undefined = AnyToolSchema | undefined,
> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: InputSchema;
  readonly outputSchema: OutputSchema;
  readonly metadata: ToolMetadata;
  readonly permissionAction?: (input: z.output<InputSchema>) => PermissionAction;
  execute(
    input: z.output<InputSchema>,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult<ToolSchemaOutput<OutputSchema>>>;
}

export interface ToolDefinitionInput<
  InputSchema extends AnyToolSchema,
  OutputSchema extends AnyToolSchema | undefined,
> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: InputSchema;
  readonly outputSchema?: OutputSchema;
  readonly metadata: ToolMetadata;
  readonly permissionAction?: ToolDefinition<InputSchema, OutputSchema>["permissionAction"];
  readonly execute: ToolDefinition<InputSchema, OutputSchema>["execute"];
}

export type ToolContractViolation = "input" | "output" | "schema";

export class ToolContractError extends PilotError {
  readonly toolName: string;
  readonly violation: ToolContractViolation;

  constructor(
    code:
      | "PILOT_TOOL_INPUT_INVALID"
      | "PILOT_TOOL_OUTPUT_INVALID"
      | "PILOT_TOOL_SCHEMA_UNSUPPORTED",
    toolName: string,
    violation: ToolContractViolation,
    message: string,
    cause?: unknown,
  ) {
    super({
      code,
      message,
      safeMessage:
        violation === "schema"
          ? "The tool schema cannot be represented for a language model"
          : `The tool ${violation} did not match its declared schema`,
      metadata: { toolName, violation },
      ...(cause === undefined ? {} : { cause }),
    });
    this.toolName = toolName;
    this.violation = violation;
  }
}

const toolNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_]*$/u, "Tool names must use lowercase snake_case");

export function defineTool<
  InputSchema extends AnyToolSchema,
  OutputSchema extends AnyToolSchema | undefined = undefined,
>(
  input: ToolDefinitionInput<InputSchema, OutputSchema>,
): ToolDefinition<InputSchema, OutputSchema> {
  const name = toolNameSchema.parse(input.name);
  const description = z.string().min(1).max(2_000).parse(input.description);
  const metadata = ToolMetadataSchema.parse(input.metadata);
  return Object.freeze({
    name,
    description,
    inputSchema: input.inputSchema,
    outputSchema: input.outputSchema as OutputSchema,
    metadata,
    ...(input.permissionAction === undefined ? {} : { permissionAction: input.permissionAction }),
    execute: input.execute,
  });
}

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
