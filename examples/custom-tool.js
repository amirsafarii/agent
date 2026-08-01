/**
 * A minimal first-class custom Tool.
 *
 * Run it through the same Registry -> Runner -> validation/permission/
 * middleware pipeline as every built-in tool:
 *
 *   const agent = buildAgent({ plugins: [myPlugin] });
 *   await agent.tools.run('hello', { name: 'Ada' });
 */

import { buildAgent, createPlugin } from '../src/index.js';

export const helloTool = {
  name: 'hello',
  description: 'Say hello to a person.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Name to greet.' },
    },
    required: ['name'],
  },
  async execute({ name }, context) {
    context.logger?.debug?.('hello:execute', { name });
    return `Hello ${name}`;
  },
};

export const customPlugin = createPlugin({
  name: 'examples',
  metadata: { author: 'application', purpose: 'example custom tools' },
  tools: [helloTool],
});

export function buildExampleAgent() {
  return buildAgent({ plugins: [customPlugin] });
}
