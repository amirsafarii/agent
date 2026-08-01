import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ModelRouter } from '../src/clients/model-router.js';

test('ModelRouter: routes basic task types correctly', () => {
  const router = new ModelRouter({
    routes: {
      simple: 'gpt-3.5-turbo',
      reasoning: 'gpt-4',
      coding: 'codellama',
      vision: 'gpt-4-vision',
    },
  });

  assert.equal(router.select({ taskType: 'simple' }), 'gpt-3.5-turbo');
  assert.equal(router.select({ taskType: 'code_repair' }), 'codellama');
  assert.equal(router.select({ taskType: 'vision' }), 'gpt-4-vision');
  assert.equal(router.select({ taskType: 'reasoning' }), 'gpt-4');
  assert.equal(router.select({ taskType: 'math', complexity: 0.2 }), 'gpt-4');
});

test('ModelRouter: routes by complexity', () => {
  const router = new ModelRouter({
    routes: {
      simple: 'cheap',
      reasoning: 'strong',
      coding: 'coder',
      vision: 'see',
    },
  });

  assert.equal(router.select({ taskType: 'general', complexity: 0.8 }), 'strong');
  assert.equal(router.select({ taskType: 'general', complexity: 0.3 }), 'cheap');
});
