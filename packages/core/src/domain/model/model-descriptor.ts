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
    /**
     * What the provider's reported prompt-token count actually measures.
     *
     * - `exact` — the size of the prompt, so it can drive the context-occupancy display.
     * - `eval-only` — only the tokens the runner evaluated. Ollama reports `prompt_eval_count`
     *   here, which collapses once the KV cache holds the conversation prefix, so the figure is a
     *   throughput measure and must never be shown as context occupancy.
     * - `unknown` — unclassified; treated as `eval-only` for display, since assuming the number is
     *   a prompt size is the failure that shows a shrinking context on a growing conversation.
     */
    promptUsageTrust: z.enum(["exact", "eval-only", "unknown"]).optional(),
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
