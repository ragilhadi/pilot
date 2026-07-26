import { maximumConfigurationBytes } from "../../constants.js";
import { ConfigurationError } from "./config-errors.js";
import { ConfigurationLayerValueSchema, type ConfigurationLayerValue } from "./config-schema.js";

export function parseJsonConfiguration(text: string, location: string): ConfigurationLayerValue {
  if (new TextEncoder().encode(text).byteLength > maximumConfigurationBytes) {
    throw new ConfigurationError(`Configuration ${location} exceeds the size limit`, { location });
  }
  try {
    const withoutBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    return ConfigurationLayerValueSchema.parse(
      JSON.parse(removeTrailingCommas(stripComments(withoutBom))),
    );
  } catch (error) {
    if (error instanceof ConfigurationError) throw error;
    throw new ConfigurationError(
      `Configuration ${location} is not valid JSONC`,
      { location },
      error,
    );
  }
}

function stripComments(text: string): string {
  let output = "";
  let quote = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    const next = text[index + 1];
    if (quote) {
      output += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quote = false;
      continue;
    }
    if (character === '"') {
      quote = true;
      output += character;
      continue;
    }
    if (character === "/" && next === "/") {
      while (index < text.length && text[index] !== "\n") index += 1;
      output += "\n";
      continue;
    }
    if (character === "/" && next === "*") {
      index += 2;
      while (index < text.length && !(text[index] === "*" && text[index + 1] === "/")) {
        output += text[index] === "\n" ? "\n" : " ";
        index += 1;
      }
      if (index >= text.length)
        throw new ConfigurationError("Configuration has an unterminated comment");
      index += 1;
      continue;
    }
    output += character;
  }
  return output;
}

function removeTrailingCommas(text: string): string {
  let output = "";
  let quote = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quote) {
      output += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quote = false;
      continue;
    }
    if (character === '"') quote = true;
    if (character === ",") {
      let lookahead = index + 1;
      while (/\s/u.test(text[lookahead] ?? "")) lookahead += 1;
      if (text[lookahead] === "}" || text[lookahead] === "]") continue;
    }
    output += character;
  }
  return output;
}
