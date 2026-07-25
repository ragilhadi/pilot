import * as z from "zod";

/**
 * The JSON value model shared by messages, tool payloads, and persistence records. Both the
 * types and their runtime schemas live here so no domain module has to re-derive them.
 */

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

export const JsonObjectSchema: z.ZodType<JsonObject> = z
  .record(z.string(), JsonValueSchema)
  .readonly();
