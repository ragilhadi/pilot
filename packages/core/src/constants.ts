/**
 * Cross-cutting constants shared across the domain modules: schema versions that gate
 * serialized payloads and the byte ceilings that bound untrusted input. Keeping them in
 * one place makes the compatibility surface easy to audit and bump deliberately.
 */

export const eventSchemaVersion = 1 as const;
export const messageSchemaVersion = 1 as const;
export const sessionSchemaVersion = 1 as const;
export const configurationSchemaVersion = 1 as const;

export const maximumConfigurationBytes = 1_048_576;
