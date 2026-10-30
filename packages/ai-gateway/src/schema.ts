/**
 * Zod output schemas → JSON schema for structured outputs (AIA-04). Providers' strict modes want every
 * object closed (`additionalProperties: false`) with all properties required, so optional fields are
 * modelled as nullable in the task schemas. Validation constraints (min/max) stay in Zod only; the
 * response is always re-validated with Zod after it arrives.
 */
import { z } from 'zod';

type Json = Record<string, unknown>;

function strictify(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strictify);
  if (!node || typeof node !== 'object') return node;
  const out: Json = {};
  for (const [k, v] of Object.entries(node as Json)) {
    if (k === '$schema' || k === 'minimum' || k === 'maximum' || k === 'minLength' || k === 'maxLength')
      continue;
    if (k === 'minItems' || k === 'maxItems' || k === 'exclusiveMinimum' || k === 'exclusiveMaximum')
      continue;
    if (k === 'pattern' || k === 'format') continue;
    out[k] = strictify(v);
  }
  if (out.type === 'object' && out.properties && typeof out.properties === 'object') {
    out.additionalProperties = false;
    out.required = Object.keys(out.properties as Json);
  }
  return out;
}

export function jsonSchemaOf(schema: z.ZodType): Record<string, unknown> {
  return strictify(z.toJSONSchema(schema, { io: 'output', unrepresentable: 'any' })) as Record<
    string,
    unknown
  >;
}
