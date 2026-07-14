'use strict';

// Anthropic structured outputs compile a supported subset of JSON Schema. Keep the full logical
// schema for commitments and local validation, then project only unsupported range/length keywords
// into human-readable descriptions for the provider transport. This mirrors the documented SDK
// transformation without making scientific bounds depend on constrained decoding.
const CONSTRAINT_LABELS = Object.freeze({
  minimum: 'Minimum value',
  maximum: 'Maximum value',
  minLength: 'Minimum length',
  maxLength: 'Maximum length',
  minItems: 'Minimum items',
  maxItems: 'Maximum items',
});

function anthropicCompatibleSchema(schema) {
  if (Array.isArray(schema)) return schema.map(anthropicCompatibleSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const projected = {};
  const constraints = [];
  for (const [key, value] of Object.entries(schema)) {
    if (Object.hasOwn(CONSTRAINT_LABELS, key)) {
      constraints.push(`${CONSTRAINT_LABELS[key]}: ${value}.`);
      continue;
    }
    projected[key] = anthropicCompatibleSchema(value);
  }
  if (constraints.length) {
    const existing = String(projected.description || '').trim();
    projected.description = [existing, ...constraints].filter(Boolean).join(' ');
  }
  return projected;
}

module.exports = { CONSTRAINT_LABELS, anthropicCompatibleSchema };
