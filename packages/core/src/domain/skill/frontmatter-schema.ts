import * as z from "zod";

/**
 * A frontmatter field that may be written either as a single scalar or as a list, so
 * `requiresTools: grep` and `requiresTools: [grep]` mean the same thing.
 */
export function frontmatterList(
  item: z.ZodType<string>,
  maximum: number,
): z.ZodType<readonly string[]> {
  return z.preprocess(
    (value) => (Array.isArray(value) ? value : [value]),
    z.array(item).max(maximum).readonly(),
  ) as unknown as z.ZodType<readonly string[]>;
}
