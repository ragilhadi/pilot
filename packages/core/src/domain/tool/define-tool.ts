import * as z from "zod";
import { toolNameSchema } from "../../shared/schema-fragments.js";
import { ToolMetadataSchema } from "./tool-metadata.js";
import type { AnyToolSchema, ToolDefinition, ToolDefinitionInput } from "./tool.types.js";

export function defineTool<
  InputSchema extends AnyToolSchema,
  OutputSchema extends AnyToolSchema | undefined = undefined,
>(
  input: ToolDefinitionInput<InputSchema, OutputSchema>,
): ToolDefinition<InputSchema, OutputSchema> {
  const name = toolNameSchema.parse(input.name);
  // A tool description is the model's only instruction manual: when to reach for the tool, which
  // sibling to prefer, and what a well-formed call looks like. 2 000 characters is not enough room
  // for that on the tools that need it most (run_command, edit, apply_patch).
  const description = z.string().min(1).max(8_192).parse(input.description);
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
