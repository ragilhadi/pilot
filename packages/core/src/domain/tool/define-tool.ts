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
