'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { anthropicCompatibleSchema } = require('../../src/intelligence/anthropic-structured-output');

test('Anthropic transport projection removes unsupported bounds without mutating the logical schema', () => {
  const logical = {
    type: 'object', additionalProperties: false,
    properties: {
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      reasons: { type: 'array', minItems: 1, maxItems: 4,
        items: { type: 'string', minLength: 1, maxLength: 120 } },
    },
    required: ['confidence', 'reasons'],
  };
  const before = JSON.stringify(logical);
  const transport = anthropicCompatibleSchema(logical);
  assert.equal(JSON.stringify(logical), before);
  assert.doesNotMatch(JSON.stringify(transport), /"(?:minimum|maximum|minLength|maxLength|minItems|maxItems)"/);
  assert.match(transport.properties.confidence.description, /Minimum value: 0.*Maximum value: 1/);
  assert.match(transport.properties.reasons.description, /Minimum items: 1.*Maximum items: 4/);
  assert.match(transport.properties.reasons.items.description, /Minimum length: 1.*Maximum length: 120/);
  assert.equal(transport.additionalProperties, false);
  assert.deepEqual(transport.required, logical.required);
});
