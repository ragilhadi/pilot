import * as z from "zod";
import { toolNameSchema } from "../../shared/schema-fragments.js";
import { ToolRiskSchema } from "../tool/index.js";
import { type FrontmatterValue, parseFrontmatterDocument } from "./frontmatter.js";
import { frontmatterList } from "./frontmatter-schema.js";
import { SkillError } from "./skill-errors.js";

/** Lowercase kebab-case skill or template name, e.g. `review-diff`. */
export const SkillNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9-]*$/u, "Skill names must use lowercase kebab-case");

export const SkillManifestSchema = z
  .object({
    name: SkillNameSchema,
    description: z.string().min(1).max(1_000),
    version: z.string().min(1).max(32).optional(),
    /**
     * Tools the skill's instructions depend on. Activation is refused when any is missing rather
     * than letting the model follow instructions for a tool it cannot call.
     */
    requiresTools: frontmatterList(toolNameSchema, 64).optional(),
    /**
     * Tools the skill forbids while it is active. This is the only direction a skill may move
     * permissions: it can subtract a tool it must not use, never grant one.
     */
    deniesTools: frontmatterList(toolNameSchema, 64).optional(),
    /**
     * Risk classes that must be confirmed while the skill is active, even when standing
     * configuration would have allowed them silently.
     */
    confirmsRisks: z.array(ToolRiskSchema).max(8).readonly().optional(),
    /** Shown next to the skill in listings; free-form. */
    argumentHint: z.string().min(1).max(200).optional(),
  })
  .strict()
  .readonly();

export type SkillManifest = z.output<typeof SkillManifestSchema>;

export interface SkillDocument {
  readonly manifest: SkillManifest;
  /** The Markdown instructions handed to the model when the skill is activated. */
  readonly body: string;
}

/** Largest instruction body a single skill may contribute, before context budgeting applies. */
export const maximumSkillBodyCharacters = 100_000;

export function parseSkillDocument(text: string, location: string): SkillDocument {
  const document = parseFrontmatterDocument(text, location);
  const manifest = parseManifest(SkillManifestSchema, document.fields, location, "skill");
  if (document.body.length === 0) {
    throw new SkillError(
      "PILOT_SKILL_DOCUMENT_INVALID",
      `${location}: the skill has frontmatter but no instructions`,
      { location, skill: manifest.name },
    );
  }
  if (document.body.length > maximumSkillBodyCharacters) {
    throw new SkillError(
      "PILOT_SKILL_LIMIT",
      `${location}: the skill body exceeds ${maximumSkillBodyCharacters} characters`,
      { location, skill: manifest.name, characters: document.body.length },
    );
  }
  return Object.freeze({ manifest, body: document.body });
}

/**
 * Runs a frontmatter mapping through a Zod schema, reporting the offending keys by name.
 *
 * Zod's own message is written for JSON payloads; a skill author needs to hear which frontmatter
 * key they got wrong.
 */
export function parseManifest<Schema extends z.ZodType>(
  schema: Schema,
  fields: Readonly<Record<string, FrontmatterValue>>,
  location: string,
  kind: "skill" | "prompt template",
): z.output<Schema> {
  const parsed = schema.safeParse(fields);
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
  throw new SkillError(
    kind === "skill" ? "PILOT_SKILL_DOCUMENT_INVALID" : "PILOT_PROMPT_TEMPLATE_INVALID",
    `${location}: invalid ${kind} frontmatter — ${issues}`,
    { location, issueCount: parsed.error.issues.length },
    parsed.error,
  );
}
