import type { AgentMessage } from "./agent-message.js";

/**
 * The text content a provider sends for a message: its text parts joined by newlines, with
 * redacted parts standing in as a marker. Shared so the request builder and the context-token
 * estimator cannot drift apart about what is actually transmitted.
 */
export function messageTextContent(message: AgentMessage): string {
  return message.parts
    .flatMap((part) => {
      if (part.type === "text") return [part.text];
      if (part.type === "redacted") return ["[redacted]"];
      return [];
    })
    .join("\n");
}

/**
 * A flat approximation of everything that crosses the wire for one message — role, text, tool-call
 * names and arguments, tool results, and image references.
 *
 * Token estimation used to run over `JSON.stringify(agentMessage)`, which counts the message id,
 * session id, run id, timestamps, provenance, metadata, and every layer of JSON escaping. None of
 * that reaches the model, so the estimate ran far above the truth and made a single tool result
 * look far more expensive than it was.
 */
export function agentMessageWireText(message: AgentMessage): string {
  const segments: string[] = [message.role];
  for (const part of message.parts) {
    switch (part.type) {
      case "text":
        segments.push(part.text);
        break;
      case "redacted":
        segments.push("[redacted]");
        break;
      case "tool-call":
        segments.push(part.toolName, JSON.stringify(part.input));
        break;
      case "tool-result":
        // Mirrors the provider, which sends a tool result as a serialized string.
        segments.push(typeof part.output === "string" ? part.output : JSON.stringify(part.output));
        break;
      case "image":
        segments.push(
          part.source.kind === "url" ? part.source.url : `data:${part.mediaType};base64`,
        );
        break;
    }
  }
  return segments.join("\n");
}
