import * as z from "zod";
import { JsonObjectSchema } from "../../shared/json.js";
import { toolNameSchema } from "../../shared/schema-fragments.js";
import { AgentMessageSchema } from "../message/index.js";

export const ModelToolDefinitionSchema = z
  .object({
    name: toolNameSchema,
    description: z.string().min(1).max(2_000),
    inputSchema: JsonObjectSchema,
    outputSchema: JsonObjectSchema.optional(),
  })
  .strict()
  .readonly();

export type ModelToolDefinition = z.output<typeof ModelToolDefinitionSchema>;

const ResponseFormatSchema = z.discriminatedUnion("type", [
  z
    .object({ type: z.literal("text") })
    .strict()
    .readonly(),
  z
    .object({
      type: z.literal("json-schema"),
      name: z.string().min(1).max(64),
      schema: JsonObjectSchema,
      strict: z.boolean(),
    })
    .strict()
    .readonly(),
]);

export const ModelRequestSchema = z
  .object({
    messages: z.array(AgentMessageSchema).min(1).readonly(),
    tools: z.array(ModelToolDefinitionSchema).readonly(),
    maxOutputTokens: z.number().int().positive().optional(),
    temperature: z.number().finite().min(0).max(2).optional(),
    toolChoice: z.enum(["auto", "none", "required"]).optional(),
    allowParallelToolCalls: z.boolean().optional(),
    responseFormat: ResponseFormatSchema.optional(),
    reasoningEffort: z.enum(["minimal", "low", "medium", "high"]).optional(),
    metadata: JsonObjectSchema.optional(),
  })
  .strict()
  .readonly();

export type ModelRequest = z.output<typeof ModelRequestSchema>;
