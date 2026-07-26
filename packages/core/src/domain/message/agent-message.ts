import * as z from "zod";
import { JsonObjectSchema } from "../../shared/json.js";
import { messageSchemaVersion } from "../../constants.js";
import { MessageValidationError } from "../../errors/pilot-error.js";
import { MessageIdSchema, RunIdSchema, SessionIdSchema } from "./identifiers.js";
import { MessagePartSchema } from "./message-part.js";
import { MessageProvenanceSchema } from "./message-provenance.js";

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

export type AgentMessage = z.output<typeof AgentMessageSchema>;

/** Parses untrusted serialized data and preserves the validation error only as an internal cause. */
export function parseAgentMessage(input: unknown): AgentMessage {
  const result = AgentMessageSchema.safeParse(input);

  if (!result.success) {
    throw new MessageValidationError(result.error.issues.length, result.error);
  }

  return result.data;
}
