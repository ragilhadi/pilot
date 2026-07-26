import type * as z from "zod";
import type { RunId, ToolCallId } from "../../shared/brand.js";
import type { JsonObject, JsonValue } from "../../shared/json.js";
import type { PermissionAction } from "../permission/index.js";
import type { ToolMetadata } from "./tool-metadata.js";

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
