import * as z from "zod";
import { JsonObjectSchema, JsonValueSchema } from "../../shared/json.js";
import { finishReasonSchema, toolNameSchema } from "../../shared/schema-fragments.js";
import { ModelFailureSchema } from "../../errors/model-error.js";
import { ToolCallIdSchema } from "../message/index.js";
import { TokenUsageSchema } from "./token-usage.js";

const streamEventBase = z.object({
  sequence: z.number().int().nonnegative(),
  responseId: z.string().min(1),
});

export const ModelStreamEventSchema = z.discriminatedUnion("type", [
  streamEventBase
    .extend({ type: z.literal("response.started") })
    .strict()
    .readonly(),
  streamEventBase
    .extend({
      type: z.literal("text.delta"),
      contentIndex: z.number().int().nonnegative(),
      delta: z.string().min(1),
    })
    .strict()
    .readonly(),
  streamEventBase
    .extend({
      type: z.literal("reasoning.delta"),
      contentIndex: z.number().int().nonnegative(),
      delta: z.string().min(1),
    })
    .strict()
    .readonly(),
  streamEventBase
    .extend({
      type: z.literal("tool-call.started"),
      contentIndex: z.number().int().nonnegative(),
      callId: ToolCallIdSchema,
      toolName: toolNameSchema,
    })
    .strict()
    .readonly(),
  streamEventBase
    .extend({
      type: z.literal("tool-call.arguments.delta"),
      callId: ToolCallIdSchema,
      delta: z.string().min(1),
    })
    .strict()
    .readonly(),
  streamEventBase
    .extend({
      type: z.literal("tool-call.completed"),
      callId: ToolCallIdSchema,
      input: JsonValueSchema,
    })
    .strict()
    .readonly(),
  streamEventBase
    .extend({
      type: z.literal("usage.updated"),
      usage: TokenUsageSchema,
    })
    .strict()
    .readonly(),
  streamEventBase
    .extend({
      type: z.literal("provider.metadata"),
      metadata: JsonObjectSchema,
    })
    .strict()
    .readonly(),
  streamEventBase
    .extend({
      type: z.literal("response.completed"),
      finishReason: finishReasonSchema,
    })
    .strict()
    .readonly(),
  streamEventBase
    .extend({
      type: z.literal("response.failed"),
      error: ModelFailureSchema,
    })
    .strict()
    .readonly(),
]);

export type ModelStreamEvent = z.output<typeof ModelStreamEventSchema>;
export type FinishReason = Extract<
  ModelStreamEvent,
  { type: "response.completed" }
>["finishReason"];
