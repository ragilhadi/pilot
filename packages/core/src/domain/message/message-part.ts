import * as z from "zod";
import { JsonValueSchema } from "../../shared/json.js";
import { httpOrHttpsUrl, toolNameSchema } from "../../shared/schema-fragments.js";
import { ToolCallIdSchema } from "./identifiers.js";

export const TextPartSchema = z
  .object({
    type: z.literal("text"),
    text: z.string().min(1),
  })
  .strict()
  .readonly();

const ImageSourceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("base64"),
      data: z.string().min(1),
    })
    .strict()
    .readonly(),
  z
    .object({
      kind: z.literal("url"),
      url: httpOrHttpsUrl("Image URLs must use HTTP or HTTPS"),
    })
    .strict()
    .readonly(),
]);

export const ImagePartSchema = z
  .object({
    type: z.literal("image"),
    mediaType: z.string().regex(/^image\/[a-z0-9.+-]+$/iu, "Expected an image media type"),
    source: ImageSourceSchema,
  })
  .strict()
  .readonly();

export const ToolCallPartSchema = z
  .object({
    type: z.literal("tool-call"),
    callId: ToolCallIdSchema,
    toolName: toolNameSchema,
    input: JsonValueSchema,
  })
  .strict()
  .readonly();

export const ToolResultPartSchema = z
  .object({
    type: z.literal("tool-result"),
    callId: ToolCallIdSchema,
    toolName: toolNameSchema,
    output: JsonValueSchema,
    isError: z.boolean(),
  })
  .strict()
  .readonly();

export const RedactedPartSchema = z
  .object({
    type: z.literal("redacted"),
    reason: z.enum(["policy", "secret", "user-request"]),
  })
  .strict()
  .readonly();

export const MessagePartSchema = z.discriminatedUnion("type", [
  TextPartSchema,
  ImagePartSchema,
  ToolCallPartSchema,
  ToolResultPartSchema,
  RedactedPartSchema,
]);

export type TextPart = z.output<typeof TextPartSchema>;
export type ImagePart = z.output<typeof ImagePartSchema>;
export type ToolCallPart = z.output<typeof ToolCallPartSchema>;
export type ToolResultPart = z.output<typeof ToolResultPartSchema>;
export type RedactedPart = z.output<typeof RedactedPartSchema>;
export type MessagePart = z.output<typeof MessagePartSchema>;
