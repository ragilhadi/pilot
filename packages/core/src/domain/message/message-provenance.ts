import * as z from "zod";
import { toolNameSchema } from "../../shared/schema-fragments.js";
import { AgentIdSchema, MessageIdSchema, ToolCallIdSchema } from "./identifiers.js";

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

export type MessageProvenance = z.output<typeof MessageProvenanceSchema>;
