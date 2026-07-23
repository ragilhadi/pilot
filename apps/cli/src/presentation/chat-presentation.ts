import type { ChatEvent } from "../chat-events.js";

export interface ChatEventSink {
  render(event: ChatEvent): void;
}

export interface InteractiveChatPresentation extends ChatEventSink {
  readLine(): Promise<string | undefined>;
  close(): Promise<void>;
}
