import type { CorrelationId, EventId, RunId, SessionId } from "./brand.js";

export const eventSchemaVersion = 1 as const;

export interface EventEnvelope<Type extends string, Payload> {
  readonly schemaVersion: typeof eventSchemaVersion;
  readonly id: EventId;
  readonly sequence: number;
  readonly type: Type;
  readonly occurredAt: string;
  readonly correlationId: CorrelationId;
  readonly causationId?: EventId;
  readonly sessionId?: SessionId;
  readonly runId?: RunId;
  readonly payload: Payload;
}

export type AppStartedEvent = EventEnvelope<
  "app.started",
  {
    readonly application: "pilot";
    readonly version: string;
    readonly runtimeVersion: string;
  }
>;

export type AppEvent = AppStartedEvent;

export type EventSubscriber = (event: AppEvent, signal?: AbortSignal) => void | Promise<void>;

export interface EventPublisher {
  publish(event: AppEvent, signal?: AbortSignal): Promise<void>;
}
