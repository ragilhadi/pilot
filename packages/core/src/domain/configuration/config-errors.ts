import { PilotError } from "../../errors/pilot-error.js";

export class ConfigurationError extends PilotError {
  constructor(message: string, metadata: Readonly<Record<string, unknown>> = {}, cause?: unknown) {
    super({
      code: "PILOT_CONFIG_INVALID",
      message,
      safeMessage: "Pilot configuration is invalid",
      metadata,
      ...(cause === undefined ? {} : { cause }),
    });
  }
}

export class MissingConfigurationEnvironmentError extends PilotError {
  constructor(variable: string) {
    super({
      code: "PILOT_CONFIG_ENVIRONMENT_MISSING",
      message: `Required configuration environment variable ${variable} is missing`,
      safeMessage: "A required configuration environment variable is missing",
      metadata: { variable },
    });
  }
}
