import {
  type AppStartedEvent,
  CancellationError,
  correlationId,
  type EventDeliveryError,
  eventId,
} from "@pilotrun/core";
import { describe, expect, it, vi } from "vitest";
import { InMemoryEventBus } from "../src/index.js";

function startupEvent(): AppStartedEvent {
  return {
    schemaVersion: 1,
    id: eventId("event-1"),
    sequence: 1,
    type: "app.started",
    occurredAt: "2026-07-20T00:00:00.000Z",
    correlationId: correlationId("correlation-1"),
    payload: {
      application: "pilot",
      version: "0.0.0",
      runtimeVersion: "0.0.0",
    },
  };
}

describe("InMemoryEventBus", () => {
  it("delivers in registration order and supports unsubscription", async () => {
    const deliveries: string[] = [];
    const bus = new InMemoryEventBus();
    const unsubscribe = bus.subscribe(() => {
      deliveries.push("first");
    });
    bus.subscribe(async () => {
      await Promise.resolve();
      deliveries.push("second");
    });

    await bus.publish(startupEvent());
    unsubscribe();
    await bus.publish(startupEvent());

    expect(deliveries).toEqual(["first", "second", "second"]);
  });

  it("isolates a subscriber failure until all subscribers receive the event", async () => {
    const bus = new InMemoryEventBus();
    const laterSubscriber = vi.fn();
    bus.subscribe(() => {
      throw new Error("subscriber secret");
    });
    bus.subscribe(laterSubscriber);

    const result = bus.publish(startupEvent());

    await expect(result).rejects.toMatchObject<EventDeliveryError>({
      code: "PILOT_EVENT_DELIVERY_FAILED",
      failureCount: 1,
    });
    expect(laterSubscriber).toHaveBeenCalledOnce();
  });

  it("honors cancellation before delivering another subscriber", async () => {
    const bus = new InMemoryEventBus();
    const controller = new AbortController();
    const laterSubscriber = vi.fn();
    bus.subscribe(() => {
      controller.abort("stop");
    });
    bus.subscribe(laterSubscriber);

    await expect(bus.publish(startupEvent(), controller.signal)).rejects.toBeInstanceOf(
      CancellationError,
    );
    expect(laterSubscriber).not.toHaveBeenCalled();
  });
});
