import {
  CancellationError,
  EventDeliveryError,
  type EventPublisher,
  type EventSubscriber,
} from "@pilot/core";

export type Unsubscribe = () => void;

/**
 * Delivers events in registration order. Subscriber failures are collected so one broken observer
 * cannot prevent later observers from receiving the event.
 */
export class InMemoryEventBus implements EventPublisher {
  readonly #subscribers = new Set<EventSubscriber>();

  subscribe(subscriber: EventSubscriber): Unsubscribe {
    this.#subscribers.add(subscriber);

    return () => {
      this.#subscribers.delete(subscriber);
    };
  }

  async publish(
    event: Parameters<EventPublisher["publish"]>[0],
    signal?: AbortSignal,
  ): Promise<void> {
    const failures: unknown[] = [];

    for (const subscriber of [...this.#subscribers]) {
      if (signal?.aborted === true) {
        throw new CancellationError(signal.reason);
      }

      try {
        await subscriber(event, signal);
      } catch (error) {
        failures.push(error);
      }
    }

    if (failures.length > 0) {
      throw new EventDeliveryError(failures.length, new AggregateError(failures));
    }
  }
}
