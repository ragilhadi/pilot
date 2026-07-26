import * as z from "zod";
import { JsonObjectSchema } from "../../shared/json.js";
import { httpOrHttpsUrl, providerIdSchema } from "../../shared/schema-fragments.js";

export const ProviderAuthSchema = z.discriminatedUnion("type", [
  z
    .object({ type: z.literal("none") })
    .strict()
    .readonly(),
  z
    .object({
      type: z.literal("environment"),
      variable: z.string().regex(/^[A-Z_][A-Z0-9_]*$/u, "Expected an environment variable name"),
    })
    .strict()
    .readonly(),
]);

export type ProviderAuth = z.output<typeof ProviderAuthSchema>;

export const ProviderConfigurationSchema = z
  .object({
    providerId: providerIdSchema,
    type: z.enum(["anthropic", "custom", "google", "openai", "openai-compatible"]),
    baseUrl: httpOrHttpsUrl("Provider URLs must use HTTP or HTTPS").optional(),
    auth: ProviderAuthSchema,
    options: JsonObjectSchema.optional(),
  })
  .strict()
  .readonly();

export type ProviderConfiguration = z.output<typeof ProviderConfigurationSchema>;
