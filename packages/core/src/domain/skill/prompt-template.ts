import * as z from "zod";
import { type Sha256Digest, sha256Digest } from "../../shared/digest.js";
import { parseFrontmatterDocument } from "./frontmatter.js";
import { frontmatterList } from "./frontmatter-schema.js";
import { parseManifest, SkillNameSchema } from "./skill-manifest.js";
import { SkillError } from "./skill-errors.js";

/** Bare placeholder name inside `{{ }}`. */
const parameterNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-zA-Z0-9]*$/u, "Template parameters must use lowerCamelCase");

/** Placeholder that expands to everything the user typed after the template name. */
export const promptTemplateArgumentsPlaceholder = "arguments";

export const PromptTemplateManifestSchema = z
  .object({
    name: SkillNameSchema,
    description: z.string().min(1).max(1_000),
    /**
     * Named parameters, filled positionally from the invocation. The last one absorbs whatever
     * text remains, so a trailing free-text parameter needs no quoting.
     */
    parameters: frontmatterList(parameterNameSchema, 16).optional(),
    argumentHint: z.string().min(1).max(200).optional(),
  })
  .strict()
  .readonly();

export type PromptTemplateManifest = z.output<typeof PromptTemplateManifestSchema>;

export interface PromptTemplate {
  readonly manifest: PromptTemplateManifest;
  /** The template text, still holding its `{{placeholder}}` markers. */
  readonly body: string;
  /** Placeholders the body actually references, sorted, for listings and validation. */
  readonly placeholders: readonly string[];
}

export const maximumPromptTemplateCharacters = 40_000;

const placeholderPattern = /\{\{(?<name>[^{}]*)\}\}/gu;

export function parsePromptTemplate(text: string, location: string): PromptTemplate {
  const document = parseFrontmatterDocument(text, location);
  const manifest = parseManifest(
    PromptTemplateManifestSchema,
    document.fields,
    location,
    "prompt template",
  );
  if (document.body.length === 0) {
    throw invalid(location, "the template has frontmatter but no body", { name: manifest.name });
  }
  if (document.body.length > maximumPromptTemplateCharacters) {
    throw invalid(
      location,
      `the template body exceeds ${maximumPromptTemplateCharacters} characters`,
      {
        name: manifest.name,
        characters: document.body.length,
      },
    );
  }
  const declared = new Set(manifest.parameters ?? []);
  const referenced = new Set<string>();
  for (const match of document.body.matchAll(placeholderPattern)) {
    const name = match.groups?.name ?? "";
    if (name !== promptTemplateArgumentsPlaceholder && !declared.has(name)) {
      throw invalid(
        location,
        `\`{{${name}}}\` is not a declared parameter; add it to \`parameters\` or use \`{{${promptTemplateArgumentsPlaceholder}}}\``,
        { name: manifest.name, placeholder: name },
      );
    }
    referenced.add(name);
  }
  for (const parameter of declared) {
    if (!referenced.has(parameter)) {
      throw invalid(location, `parameter \`${parameter}\` is declared but never referenced`, {
        name: manifest.name,
        parameter,
      });
    }
  }
  // A template with no placeholders at all is a legitimate fixed prompt; expansion refuses
  // arguments for it rather than discarding them silently.
  return Object.freeze({
    manifest,
    body: document.body,
    placeholders: Object.freeze([...referenced].sort()),
  });
}

export const promptTemplateExpansionSchemaVersion = 1 as const;

export interface PromptTemplateExpansion {
  readonly schemaVersion: typeof promptTemplateExpansionSchemaVersion;
  readonly name: string;
  /** The fully substituted prompt text sent as the user's turn. */
  readonly text: string;
  /** The value bound to each declared parameter, for the audit record. */
  readonly parameters: Readonly<Record<string, string>>;
  /** Digest of the template body the expansion came from. */
  readonly templateSha256: Sha256Digest;
  /** Digest over template identity, body, and bound values: equal inputs always expand equally. */
  readonly fingerprint: Sha256Digest;
}

/**
 * Substitutes a template's placeholders in a single left-to-right pass.
 *
 * One pass is the security property, not an optimization: substituted argument text is never
 * re-scanned, so `{{arguments}}` containing `{{deniesTools}}` stays literal text instead of
 * reaching back into the template's own vocabulary.
 */
export async function expandPromptTemplate(
  template: PromptTemplate,
  argumentText: string,
): Promise<PromptTemplateExpansion> {
  const declared = template.manifest.parameters ?? [];
  const trimmed = argumentText.trim();
  const acceptsArguments =
    declared.length > 0 || template.placeholders.includes(promptTemplateArgumentsPlaceholder);
  if (trimmed.length > 0 && !acceptsArguments) {
    throw invalid(template.manifest.name, "the template takes no arguments", {
      name: template.manifest.name,
    });
  }
  const bound = bindParameters(template.manifest.name, declared, trimmed);
  const values: Readonly<Record<string, string>> = Object.freeze({
    ...bound,
    [promptTemplateArgumentsPlaceholder]: trimmed,
  });

  let text = "";
  let cursor = 0;
  for (const match of template.body.matchAll(placeholderPattern)) {
    const index = match.index;
    text += template.body.slice(cursor, index);
    text += values[match.groups?.name ?? ""] ?? "";
    cursor = index + match[0].length;
  }
  text += template.body.slice(cursor);

  const templateSha256 = await sha256Digest(template.body);
  const fingerprint = await sha256Digest(
    JSON.stringify([
      promptTemplateExpansionSchemaVersion,
      template.manifest.name,
      templateSha256,
      [...Object.entries(values)].sort(([left], [right]) => left.localeCompare(right)),
    ]),
  );
  return Object.freeze({
    schemaVersion: promptTemplateExpansionSchemaVersion,
    name: template.manifest.name,
    text,
    parameters: Object.freeze({ ...bound }),
    templateSha256,
    fingerprint,
  });
}

/**
 * Fills declared parameters positionally. The final parameter absorbs the rest of the line so a
 * trailing prose argument needs no quoting; every earlier one takes a single token.
 */
function bindParameters(
  name: string,
  declared: readonly string[],
  argumentText: string,
): Readonly<Record<string, string>> {
  if (declared.length === 0) return Object.freeze({});
  const tokens = tokenize(name, argumentText);
  const bound: Record<string, string> = {};
  declared.forEach((parameter, index) => {
    const value =
      index === declared.length - 1 ? tokens.slice(index).join(" ") : (tokens[index] ?? "");
    if (value.length > 0) bound[parameter] = value;
  });
  const missing = declared.filter((parameter) => bound[parameter] === undefined);
  if (missing.length > 0) {
    throw new SkillError(
      "PILOT_PROMPT_TEMPLATE_INVALID",
      `Prompt template ${name} requires ${missing.join(", ")}`,
      { name, missing: Object.freeze([...missing]) },
    );
  }
  return Object.freeze(bound);
}

/** Splits on whitespace, keeping double-quoted runs together so one token can contain spaces. */
function tokenize(name: string, argumentText: string): readonly string[] {
  const tokens: string[] = [];
  let current: string | undefined;
  let quoted = false;
  for (const character of argumentText) {
    if (quoted) {
      if (character === '"') {
        quoted = false;
        continue;
      }
      current = (current ?? "") + character;
      continue;
    }
    if (character === '"') {
      quoted = true;
      current ??= "";
      continue;
    }
    if (/\s/u.test(character)) {
      if (current !== undefined) tokens.push(current);
      current = undefined;
      continue;
    }
    current = (current ?? "") + character;
  }
  if (quoted) {
    throw new SkillError(
      "PILOT_PROMPT_TEMPLATE_INVALID",
      `Prompt template ${name} was given an unclosed quote`,
      { name },
    );
  }
  if (current !== undefined) tokens.push(current);
  return Object.freeze(tokens);
}

function invalid(
  location: string,
  detail: string,
  metadata: Readonly<Record<string, unknown>>,
): SkillError {
  return new SkillError(
    "PILOT_PROMPT_TEMPLATE_INVALID",
    `${location}: ${detail}`,
    Object.freeze({ location, ...metadata }),
  );
}
