import {
  type ModelToolDefinition,
  parseToolInput,
  parseToolOutput,
  PilotError,
  type ToolDefinition,
  type ToolSchemaOutput,
  toolToModelDefinition,
} from "@pilotrun/core";
import type * as z from "zod";

export class ToolNotFoundError extends PilotError {
  readonly toolName: string;

  constructor(toolName: string) {
    super({
      code: "PILOT_TOOL_NOT_FOUND",
      message: `Tool ${toolName} is not registered`,
      metadata: { toolName },
    });
    this.toolName = toolName;
  }
}

export class ToolRegistrationConflictError extends PilotError {
  readonly toolName: string;

  constructor(toolName: string) {
    super({
      code: "PILOT_TOOL_REGISTRATION_CONFLICT",
      message: `Tool ${toolName} is already registered`,
      metadata: { toolName },
    });
    this.toolName = toolName;
  }
}

export interface RegisteredTool {
  readonly definition: ToolDefinition;
  readonly modelDefinition: ModelToolDefinition;
}

/** Collision-safe registry and the validation boundary for model-supplied tool data. */
export class ToolRegistry {
  readonly #tools = new Map<string, RegisteredTool>();

  constructor(definitions: readonly ToolDefinition[] = []) {
    for (const definition of definitions) {
      this.register(definition);
    }
  }

  register(definition: ToolDefinition): RegisteredTool {
    if (this.#tools.has(definition.name)) {
      throw new ToolRegistrationConflictError(definition.name);
    }
    const registered = Object.freeze({
      definition,
      modelDefinition: toolToModelDefinition(definition),
    });
    this.#tools.set(definition.name, registered);
    return registered;
  }

  has(toolName: string): boolean {
    return this.#tools.has(toolName);
  }

  resolve(toolName: string): RegisteredTool {
    const registered = this.#tools.get(toolName);
    if (registered === undefined) {
      throw new ToolNotFoundError(toolName);
    }
    return registered;
  }

  list(): readonly RegisteredTool[] {
    return Object.freeze(
      [...this.#tools.values()].sort((left, right) =>
        left.definition.name.localeCompare(right.definition.name),
      ),
    );
  }

  modelDefinitions(): readonly ModelToolDefinition[] {
    return Object.freeze(this.list().map(({ modelDefinition }) => modelDefinition));
  }

  parseInput(toolName: string, input: unknown): z.output<ToolDefinition["inputSchema"]> {
    return parseToolInput(this.resolve(toolName).definition, input);
  }

  parseOutput(toolName: string, output: unknown): ToolSchemaOutput<ToolDefinition["outputSchema"]> {
    return parseToolOutput(this.resolve(toolName).definition, output);
  }
}
