/**
 * src/mcp/validation.ts
 *
 * Strict JSON-Schema validation for MCP tool input schemas.
 * Produces precise errors (with path) mapped to JSON-RPC -32602 Invalid params.
 *
 * Supports: type (string|number|boolean|integer|array|object|null and unions),
 * enum, required, minimum/maximum, minLength/maxLength, items, default,
 * additionalProperties:false, and nested properties.
 */

export interface ValidationError {
  path:  string;
  error: string;
}

export type ValidationResult =
  | { valid: true; data: Record<string, unknown> }
  | { valid: false; errors: ValidationError[] };

/** Validate `value` against a JSON Schema node, collecting path errors. */
export function validateSchemaNode(value: unknown, schema: Record<string, unknown>, path = '$'): ValidationError[] {
  const errors: ValidationError[] = [];

  // null guard for non-nullable types
  const schemaType = schema.type;
  if (value === undefined || value === null) {
    const types = Array.isArray(schemaType) ? schemaType : [schemaType];
    if (!types.includes('null')) {
      errors.push({ path, error: 'Value is required but missing' });
      return errors;
    }
    if (value === null) return errors;
  }

  const types = Array.isArray(schemaType) ? schemaType : typeof schemaType === 'string' ? [schemaType] : [];
  const hasEnum = Array.isArray(schema.enum) && (schema.enum as unknown[]).length > 0;

  if (Array.isArray(types) && types.length > 0 && !hasEnum) {
    const coerced = coerceType(value, types);
    if (coerced.kind === 'invalid') {
      errors.push({ path, error: `Expected type ${types.join(' or ')}, got ${typeOf(value)}` });
      return errors;
    }
    value = coerced.value;
  }

  if (hasEnum) {
    const allowed = (schema.enum as unknown[]).map(v => String(v));
    if (!allowed.includes(String(value))) {
      errors.push({
        path,
        error: `Value must be one of: ${allowed.join(', ')}`,
      });
      return errors;
    }
  }

  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      errors.push({ path, error: `Value must be >= ${schema.minimum}` });
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      errors.push({ path, error: `Value must be <= ${schema.maximum}` });
    }
  }

  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      errors.push({ path, error: `String must be at least ${schema.minLength} characters` });
    }
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
      errors.push({ path, error: `String must be at most ${schema.maxLength} characters` });
    }
    if (typeof schema.pattern === 'string') {
      try {
        if (!new RegExp(schema.pattern).test(value)) {
          errors.push({ path, error: `String must match pattern ${schema.pattern}` });
        }
      } catch { /* invalid regex — ignore */ }
    }
  }

  if (Array.isArray(value) && schema.items) {
    for (let i = 0; i < value.length; i++) {
      errors.push(...validateSchemaNode(value[i], schema.items as Record<string, unknown>, `${path}[${i}]`));
    }
  }

  if (typeof value === 'object' && !Array.isArray(value) && schemaType !== 'array') {
    const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
    const required = (schema.required ?? []) as string[];
    const out: Record<string, unknown> = {};

    for (const key of required) {
      if (!(key in (value as Record<string, unknown>))) {
        errors.push({ path: `${path}.${key}`, error: 'Required property is missing' });
      }
    }

    for (const key of Object.keys(value as Record<string, unknown>)) {
      if (Object.prototype.hasOwnProperty.call(props, key)) {
        out[key] = (value as Record<string, unknown>)[key];
      } else if (schema.additionalProperties === false) {
        errors.push({ path: `${path}.${key}`, error: 'Unexpected additional property' });
      }
      // unknown properties with additionalProperties true are kept silently
    }

    for (const [key, propSchema] of Object.entries(props)) {
      if (key in (value as Record<string, unknown>)) {
        const childErrors = validateSchemaNode((value as Record<string, unknown>)[key], propSchema, `${path}.${key}`);
        errors.push(...childErrors);
        if (childErrors.length === 0) {
          // Store the coerced value (e.g. numeric strings → numbers) so callers
          // get properly typed data instead of raw JSON strings.
          out[key] = coerceChildValue((value as Record<string, unknown>)[key], propSchema);
        }
      } else if (propSchema.default !== undefined) {
        out[key] = propSchema.default;
      }
    }
  }

  return errors;
}

/**
 * Validate and simultaneously coerce a top-level args object. Returns the
 * merged, typed data (defaults applied, strings → numbers coerced) alongside
 * the error list. Used by validateToolInput so the caller receives data ready
 * for the tool handler.
 */
function validateObject(
  value: Record<string, unknown>,
  schema: Record<string, unknown>,
): { errors: ValidationError[]; out: Record<string, unknown> } {
  const out: Record<string, unknown> = {};
  const errors: ValidationError[] = [];
  const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = (schema.required ?? []) as string[];
  const schemaType = schema.type;

  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { errors: [{ path: '$', error: `Expected object, got ${typeof value === 'object' && Array.isArray(value) ? 'array' : typeof value}` }], out };
  }
  if (schemaType !== undefined && schemaType !== 'object' && !Array.isArray(schemaType)) {
    // top-level declares a primitive type — delegate to node validation
    return { errors: validateSchemaNode(value, schema, '$'), out: value as Record<string, unknown> };
  }

  for (const key of required) {
    if (!(key in value)) errors.push({ path: `$.${key}`, error: 'Required property is missing' });
  }
  for (const key of Object.keys(value)) {
    if (!Object.prototype.hasOwnProperty.call(props, key)) {
      if (schema.additionalProperties === false) errors.push({ path: `$.${key}`, error: 'Unexpected additional property' });
    }
  }
  for (const [key, propSchema] of Object.entries(props)) {
    if (key in value) {
      const childErrors = validateSchemaNode(value[key], propSchema, `$.${key}`);
      errors.push(...childErrors);
      if (childErrors.length === 0) out[key] = coerceChildValue(value[key], propSchema);
    } else if (propSchema.default !== undefined) {
      out[key] = propSchema.default;
    }
  }
  return { errors, out };
}

/** Re-run type coercion on a child value with its schema (for storing typed data). */
function coerceChildValue(value: unknown, schema: Record<string, unknown>): unknown {
  const schemaType = schema.type;
  const types = Array.isArray(schemaType) ? schemaType : typeof schemaType === 'string' ? [schemaType] : [];
  if (types.length === 0) return value;
  const actual = typeOf(value);
  if (types.includes(actual)) return value;
  if (types.includes('integer') && actual === 'string' && Number.isInteger(Number(value))) return Number(value);
  if (types.includes('number') && actual === 'string' && Number.isFinite(Number(value))) return Number(value);
  if (types.includes('string') && types.includes('number') && actual === 'number') return String(value);
  return value;
}

/** Type-coerce JSON values (strings to numbers etc.) — MCP clients send raw JSON. */
function coerceType(value: unknown, types: unknown[]): { kind: 'valid'; value: unknown } | { kind: 'invalid' } {
  const actual = typeOf(value);
  if (types.includes(actual)) return { kind: 'valid', value };
  // string→number / number→string coercion when both types allowed
  if (types.includes('string') && types.includes('number')) {
    if (actual === 'string') {
      const n = Number(value);
      if (Number.isFinite(n)) return { kind: 'valid', value: n };
      return { kind: 'valid', value };
    }
    if (actual === 'number') return { kind: 'valid', value: String(value) };
  }
  // JSON is often imprecise with integer boundaries: accept numeric strings when
  // the schema declares integer (number, or boolean-ish) values.
  if (types.includes('integer') && actual === 'string' && Number.isInteger(Number(value))) {
    return { kind: 'valid', value: Number(value) };
  }
  if (types.includes('number') && actual === 'string' && Number.isFinite(Number(value))) {
    return { kind: 'valid', value: Number(value) };
  }
  if (types.includes('boolean') && actual === 'string') {
    if (value === 'true') return { kind: 'valid', value: true };
    if (value === 'false') return { kind: 'valid', value: false };
  }
  return { kind: 'invalid' };
}

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  const t = typeof value;
  return t === 'number' ? Number.isInteger(value) ? 'integer' : 'number' : t;
}

/** Validate a tool call argument object against its input schema. */
export function validateToolInput(
  args: Record<string, unknown> | undefined,
  schema: { type: 'object'; properties: Record<string, Record<string, unknown>>; required?: string[] },
): ValidationResult {
  const normalized = args ?? {};
  const { errors, out } = validateObject(normalized, schema as unknown as Record<string, unknown>);
  if (errors.length > 0) return { valid: false, errors };
  return { valid: true, data: out };
}

/** Map a validation failure to a JSON-RPC -32602 error. */
export function invalidParamsError(errors: ValidationError[], toolName: string): {
  code: number;
  message: string;
  data: { tool: string; errors: ValidationError[] };
} {
  const summary = errors.length === 1 && errors[0]
    ? errors[0].error
    : `${errors.length} parameter errors`;
  return {
    code: -32602,
    message: `Invalid arguments for tool "${toolName}": ${summary}`,
    data: { tool: toolName, errors },
  };
}

