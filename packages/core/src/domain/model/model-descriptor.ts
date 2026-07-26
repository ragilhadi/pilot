import * as z from "zod";
import { JsonObjectSchema } from "../../shared/json.js";
import { ModelKeySchema } from "./model-key.js";

export const ModelCapabilitiesSchema = z
  .object({
    streaming: z.boolean(),
    nativeToolCalling: z.boolean(),
    parallelToolCalls: z.boolean(),
    structuredOutput: z.boolean(),
    vision: z.boolean(),
    promptCaching: z.boolean(),
    reasoning: z.boolean(),
    configurableReasoningEffort: z.boolean(),
    systemMessages: z.boolean(),
    maxContextTokens: z.number().int().positive().optional(),
    maxOutputTokens: z.number().int().positive().optional(),
  })
  .strict()
  .superRefine((capabilities, context) => {
    if (capabilities.parallelToolCalls && !capabilities.nativeToolCalling) {
      context.addIssue({
        code: "custom",
        path: ["parallelToolCalls"],
        message: "Parallel tool calls require native tool calling",
      });
    }
    if (capabilities.configurableReasoningEffort && !capabilities.reasoning) {
      context.addIssue({
        code: "custom",
        path: ["configurableReasoningEffort"],
        message: "Configurable reasoning effort requires reasoning support",
      });
    }
  })
  .readonly();

export type ModelCapabilities = z.output<typeof ModelCapabilitiesSchema>;

export const ModelDescriptorSchema = z
  .object({
    key: ModelKeySchema,
    displayName: z.string().min(1),
    capabilities: ModelCapabilitiesSchema,
    metadata: JsonObjectSchema.optional(),
  })
  .strict()
  .readonly();

export type ModelDescriptor = z.output<typeof ModelDescriptorSchema>;
