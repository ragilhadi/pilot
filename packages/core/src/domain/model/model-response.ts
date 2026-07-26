import * as z from "zod";
import { JsonObjectSchema } from "../../shared/json.js";
import { finishReasonSchema } from "../../shared/schema-fragments.js";
import { AgentMessageSchema } from "../message/index.js";
import { TokenUsageSchema } from "./token-usage.js";

export const ModelResponseSchema = z
  .object({
    responseId: z.string().min(1),
    message: AgentMessageSchema,
    finishReason: finishReasonSchema,
    usage: TokenUsageSchema.optional(),
    providerMetadata: JsonObjectSchema.optional(),
  })
  .strict()
  .superRefine((response, context) => {
    if (response.message.role !== "assistant") {
      context.addIssue({
        code: "custom",
        path: ["message", "role"],
        message: "A model response must contain an assistant message",
      });
    }
  })
  .readonly();

export type ModelResponse = z.output<typeof ModelResponseSchema>;
