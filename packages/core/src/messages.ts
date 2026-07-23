import * as z from "zod";
import {
  agentId,
  messageId,
  runId,
  sessionId,
  toolCallId,
  type AgentId,
  type MessageId,
  type RunId,
  type SessionId,
  type ToolCallId,
} from "./brand.js";
import { MessageValidationError } from "./errors.js";

export const messageSchemaVersion = 1 as const;

export type JsonPrimitive = boolean | null | number | string;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema).readonly(),
    z.record(z.string(), JsonValueSchema).readonly(),
  ]),
);

const nonEmptyIdentifier = z.string().refine((value) => value.trim().length > 0, {
  error: "Identifier must not be empty",
});

export const AgentIdSchema: z.ZodType<AgentId> = nonEmptyIdentifier.transform(agentId);
export const MessageIdSchema: z.ZodType<MessageId> = nonEmptyIdentifier.transform(messageId);
export const RunIdSchema: z.ZodType<RunId> = nonEmptyIdentifier.transform(runId);
export const SessionIdSchema: z.ZodType<SessionId> = nonEmptyIdentifier.transform(sessionId);
export const ToolCallIdSchema: z.ZodType<ToolCallId> = nonEmptyIdentifier.transform(toolCallId);

const toolNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_]*$/u, "Tool names must use lowercase snake_case");

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
      url: z.url().refine((value) => {
        const protocol = new URL(value).protocol;
        return protocol === "http:" || protocol === "https:";
      }, "Image URLs must use HTTP or HTTPS"),
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

const UserProvenanceSchema = z
  .object({
    kind: z.literal("user"),
    channel: z.enum(["cli", "ide", "sdk", "server"]),
    agentId: AgentIdSchema.optional(),
  })
  .strict()
  .readonly();

const SystemProvenanceSchema = z
  .object({
    kind: z.literal("system"),
    source: z.enum(["builtin", "context", "global-instructions", "project-instructions", "skill"]),
    agentId: AgentIdSchema.optional(),
  })
  .strict()
  .readonly();

const ModelProvenanceSchema = z
  .object({
    kind: z.literal("model"),
    providerId: z.string().min(1),
    modelId: z.string().min(1),
    responseId: z.string().min(1).optional(),
    agentId: AgentIdSchema.optional(),
  })
  .strict()
  .readonly();

const ToolProvenanceSchema = z
  .object({
    kind: z.literal("tool"),
    callId: ToolCallIdSchema,
    toolName: toolNameSchema,
    agentId: AgentIdSchema.optional(),
  })
  .strict()
  .readonly();

const CompactionProvenanceSchema = z
  .object({
    kind: z.literal("compaction"),
    sourceMessageIds: z.array(MessageIdSchema).min(1).readonly(),
    agentId: AgentIdSchema.optional(),
  })
  .strict()
  .readonly();

export const MessageProvenanceSchema = z.discriminatedUnion("kind", [
  UserProvenanceSchema,
  SystemProvenanceSchema,
  ModelProvenanceSchema,
  ToolProvenanceSchema,
  CompactionProvenanceSchema,
]);

const allowedPartsByRole = {
  assistant: new Set(["redacted", "text", "tool-call"]),
  system: new Set(["redacted", "text"]),
  tool: new Set(["redacted", "tool-result"]),
  user: new Set(["image", "redacted", "text"]),
} as const;

const allowedProvenanceByRole = {
  assistant: new Set(["compaction", "model"]),
  system: new Set(["compaction", "system"]),
  tool: new Set(["tool"]),
  user: new Set(["user"]),
} as const;

const JsonObjectSchema: z.ZodType<JsonObject> = z.record(z.string(), JsonValueSchema).readonly();

export const AgentMessageSchema = z
  .object({
    schemaVersion: z.literal(messageSchemaVersion),
    id: MessageIdSchema,
    sessionId: SessionIdSchema,
    runId: RunIdSchema.optional(),
    parentId: MessageIdSchema.optional(),
    role: z.enum(["system", "user", "assistant", "tool"]),
    status: z.enum(["partial", "complete", "failed", "redacted"]),
    parts: z.array(MessagePartSchema).min(1).readonly(),
    createdAt: z.iso.datetime({ offset: true }),
    provenance: MessageProvenanceSchema,
    metadata: JsonObjectSchema.optional(),
  })
  .strict()
  .superRefine((message, context) => {
    if (!allowedProvenanceByRole[message.role].has(message.provenance.kind)) {
      context.addIssue({
        code: "custom",
        path: ["provenance", "kind"],
        message: `Provenance ${message.provenance.kind} is invalid for role ${message.role}`,
      });
    }

    for (const [index, part] of message.parts.entries()) {
      if (!allowedPartsByRole[message.role].has(part.type)) {
        context.addIssue({
          code: "custom",
          path: ["parts", index, "type"],
          message: `Part ${part.type} is invalid for role ${message.role}`,
        });
      }
    }

    const toolCalls = message.parts.filter((part) => part.type === "tool-call");
    if (new Set(toolCalls.map((part) => part.callId)).size !== toolCalls.length) {
      context.addIssue({
        code: "custom",
        path: ["parts"],
        message: "Tool call identifiers must be unique within a message",
      });
    }

    if (message.role === "tool" && message.provenance.kind === "tool") {
      const results = message.parts.filter((part) => part.type === "tool-result");
      if (
        results.length !== 1 ||
        results[0]?.callId !== message.provenance.callId ||
        results[0]?.toolName !== message.provenance.toolName
      ) {
        context.addIssue({
          code: "custom",
          path: ["parts"],
          message: "A tool message must contain one result matching its provenance",
        });
      }
    }
  })
  .readonly();

export type TextPart = z.output<typeof TextPartSchema>;
export type ImagePart = z.output<typeof ImagePartSchema>;
export type ToolCallPart = z.output<typeof ToolCallPartSchema>;
export type ToolResultPart = z.output<typeof ToolResultPartSchema>;
export type RedactedPart = z.output<typeof RedactedPartSchema>;
export type MessagePart = z.output<typeof MessagePartSchema>;
export type MessageProvenance = z.output<typeof MessageProvenanceSchema>;
export type AgentMessage = z.output<typeof AgentMessageSchema>;

/** Parses untrusted serialized data and preserves the validation error only as an internal cause. */
export function parseAgentMessage(input: unknown): AgentMessage {
  const result = AgentMessageSchema.safeParse(input);

  if (!result.success) {
    throw new MessageValidationError(result.error.issues.length, result.error);
  }

  return result.data;
}
