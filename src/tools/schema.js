/**
 * tools/schema.js — the central input-schema layer
 * -------------------------------------------------
 * The public contract uses ordinary JSON Schema objects:
 *
 *   { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] }
 *
 * The original ScrappyAi tools used a small `{ field: { type, required } }`
 * shorthand. It is normalized here, once, so legacy built-ins and new custom
 * tools use exactly the same validation pipeline.
 *
 * This is deliberately a small JSON-Schema subset. It covers the types and
 * constraints useful for tool arguments without adding a dependency or a
 * build step. Unknown schema keywords are retained for LLM definitions but
 * ignored by the validator.
 *
 * Pure JavaScript (ES modules).
 */

/**
 * Normalize either a full object schema or the legacy parameter-map shorthand
 * into a JSON-Schema object schema.
 *
 * @param {Object} schema
 * @returns {Object}
 */
export function normalizeInputSchema(schema = {}) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return { type: 'object', properties: {}, required: [] };
  }

  // Full JSON Schema: `properties`, `required`, or an explicit object type
  // identifies the canonical shape. Clone recursively so callers cannot
  // mutate the registered contract through a returned definition.
  if (
    Object.prototype.hasOwnProperty.call(schema, 'properties') ||
    schema.type === 'object' ||
    Array.isArray(schema.required)
  ) {
    const out = cloneSchema(schema);
    out.type = out.type || 'object';
    out.properties = out.properties && typeof out.properties === 'object' && !Array.isArray(out.properties)
      ? out.properties
      : {};
    out.required = Array.isArray(out.required) ? [...out.required] : [];
    return out;
  }

  // Legacy shorthand: { q: { type: 'string', required: true } }
  const properties = {};
  const required = [];
  for (const [name, rawSpec] of Object.entries(schema)) {
    const spec = rawSpec && typeof rawSpec === 'object' && !Array.isArray(rawSpec)
      ? cloneSchema(rawSpec)
      : {};
    if (spec.required === true) required.push(name);
    delete spec.required;
    properties[name] = spec;
  }
  return { type: 'object', properties, required };
}

/**
 * Convert a canonical object schema back to the legacy parameter-map shape.
 * This is only for old provider adapters/callers; validation always uses the
 * canonical schema above.
 *
 * @param {Object} schema
 * @returns {Object}
 */
export function legacyParametersFromSchema(schema = {}) {
  const normalized = normalizeInputSchema(schema);
  const required = new Set(normalized.required || []);
  const properties = normalized.properties || {};
  const out = {};
  for (const [name, rawSpec] of Object.entries(properties)) {
    const spec = rawSpec && typeof rawSpec === 'object' ? cloneSchema(rawSpec) : {};
    if (required.has(name)) spec.required = true;
    out[name] = spec;
  }
  return out;
}

/**
 * Validate an input value against a normalized (or legacy) tool schema.
 *
 * @param {Object} schema
 * @param {*} input
 * @returns {{ok:true, errors:[]}|{ok:false, errors:string[]}}
 */
export function validateInput(schema, input) {
  const normalized = normalizeInputSchema(schema);
  const errors = [];
  validateValue(input === undefined ? {} : input, normalized, '', errors);
  return errors.length ? { ok: false, errors } : { ok: true, errors: [] };
}

/** A small value object useful when a caller wants an explicit schema instance. */
export class ToolSchema {
  constructor(schema = {}) {
    this.schema = normalizeInputSchema(schema);
  }

  validate(input) {
    return validateInput(this.schema, input);
  }

  toJSON() {
    return cloneSchema(this.schema);
  }
}

function validateValue(value, schema, path, errors) {
  if (!schema || typeof schema !== 'object') return;

  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => sameValue(candidate, value))) {
    errors.push(`${label(path)} must be one of [${schema.enum.join(', ')}], got "${String(value)}".`);
    return;
  }

  if (schema.const !== undefined && !sameValue(schema.const, value)) {
    errors.push(`${label(path)} must equal ${JSON.stringify(schema.const)}.`);
    return;
  }

  if (schema.type && !matchesType(value, schema.type)) {
    errors.push(`${label(path)} must be of type "${schema.type}", got "${typeOf(value)}".`);
    return;
  }

  if (typeof value === 'string') {
    if (Number.isFinite(schema.minLength) && value.length < schema.minLength) {
      errors.push(`${label(path)} must contain at least ${schema.minLength} characters.`);
    }
    if (Number.isFinite(schema.maxLength) && value.length > schema.maxLength) {
      errors.push(`${label(path)} must contain at most ${schema.maxLength} characters.`);
    }
    if (schema.pattern) {
      try {
        if (!new RegExp(schema.pattern).test(value)) errors.push(`${label(path)} has an invalid format.`);
      } catch (_err) {
        errors.push(`${label(path)} has an invalid schema pattern.`);
      }
    }
  }

  if (typeof value === 'number') {
    if (Number.isFinite(schema.minimum) && value < schema.minimum) errors.push(`${label(path)} must be >= ${schema.minimum}.`);
    if (Number.isFinite(schema.maximum) && value > schema.maximum) errors.push(`${label(path)} must be <= ${schema.maximum}.`);
  }

  if (Array.isArray(value)) {
    if (Number.isFinite(schema.minItems) && value.length < schema.minItems) {
      errors.push(`${label(path)} must contain at least ${schema.minItems} item(s).`);
    }
    if (Number.isFinite(schema.maxItems) && value.length > schema.maxItems) {
      errors.push(`${label(path)} must contain at most ${schema.maxItems} item(s).`);
    }
    if (schema.items && typeof schema.items === 'object') {
      value.forEach((item, index) => validateValue(item, schema.items, `${path}[${index}]`, errors));
    }
  }

  if (isObject(value)) {
    const properties = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const key of required) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) {
        errors.push(path ? `Missing required argument "${path}.${key}".` : `Missing required argument "${key}".`);
      }
    }
    for (const [key, childSchema] of Object.entries(properties)) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      validateValue(value[key], childSchema, path ? `${path}.${key}` : key, errors);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.prototype.hasOwnProperty.call(properties, key)) {
          errors.push(`Unexpected argument "${path ? `${path}.` : ''}${key}".`);
        }
      }
    }
  }
}

function matchesType(value, type) {
  if (Array.isArray(type)) return type.some((t) => matchesType(value, t));
  switch (type) {
    case 'object': return isObject(value);
    case 'array': return Array.isArray(value);
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return Number.isInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'null': return value === null;
    default: return true;
  }
}

function typeOf(value) {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  return typeof value;
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function label(path) {
  return path ? `Argument "${path}"` : 'Input';
}

function sameValue(a, b) {
  return Object.is(a, b) || (typeof a === 'number' && typeof b === 'number' && Number.isNaN(a) && Number.isNaN(b));
}

function cloneSchema(value) {
  if (Array.isArray(value)) return value.map(cloneSchema);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, child] of Object.entries(value)) out[key] = cloneSchema(child);
  return out;
}

export default ToolSchema;
