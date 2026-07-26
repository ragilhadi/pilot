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
} from "../../shared/brand.js";

const nonEmptyIdentifier = z.string().refine((value) => value.trim().length > 0, {
  error: "Identifier must not be empty",
});

export const AgentIdSchema: z.ZodType<AgentId> = nonEmptyIdentifier.transform(agentId);
export const MessageIdSchema: z.ZodType<MessageId> = nonEmptyIdentifier.transform(messageId);
export const RunIdSchema: z.ZodType<RunId> = nonEmptyIdentifier.transform(runId);
export const SessionIdSchema: z.ZodType<SessionId> = nonEmptyIdentifier.transform(sessionId);
export const ToolCallIdSchema: z.ZodType<ToolCallId> = nonEmptyIdentifier.transform(toolCallId);
