import type * as z from "zod";
import { ModelContractValidationError } from "../../errors/model-error.js";
import { ModelCapabilitiesSchema, ModelDescriptorSchema } from "./model-descriptor.js";
import { ModelRequestSchema } from "./model-request.js";
import { ModelStreamEventSchema } from "./model-stream-event.js";
import { ProviderConfigurationSchema } from "./provider-configuration.js";
import type { ModelCapabilities, ModelDescriptor } from "./model-descriptor.js";
import type { ModelRequest } from "./model-request.js";
import type { ModelStreamEvent } from "./model-stream-event.js";
import type { ProviderConfiguration } from "./provider-configuration.js";

function parseContract<Output>(
  contract: string,
  schema: z.ZodType<Output>,
  input: unknown,
): Output {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ModelContractValidationError(contract, result.error.issues.length, result.error);
  }

  return result.data;
}

export function parseModelRequest(input: unknown): ModelRequest {
  return parseContract("model request", ModelRequestSchema, input);
}

export function parseModelCapabilities(input: unknown): ModelCapabilities {
  return parseContract("model capabilities", ModelCapabilitiesSchema, input);
}

export function parseModelDescriptor(input: unknown): ModelDescriptor {
  return parseContract("model descriptor", ModelDescriptorSchema, input);
}

export function parseModelStreamEvent(input: unknown): ModelStreamEvent {
  return parseContract("model stream event", ModelStreamEventSchema, input);
}

export function parseProviderConfiguration(input: unknown): ProviderConfiguration {
  return parseContract("provider configuration", ProviderConfigurationSchema, input);
}
