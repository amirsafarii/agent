# Modular Tool System

The Tool system is independent from `AgentLoop`, the model Router and the
Agent core. A Tool is the executable unit; a Plugin is only a named container
for one or more Tools.

```text
AgentLoop / Router
       |
       v
ToolRegistry -- discovery, registration, plugin ownership, definitions
       |
       v
ToolRunner -- validation -> permission -> middleware -> execute -> normalize
       |
       v
ToolContext / ToolResult
```

The implementation intentionally does **not** load plugins dynamically, read
plugins from the filesystem, load npm plugins, generate tools, or sandbox a
plugin. Those are future concerns outside this refactor.

## Tool contract

New Tools use the small stable contract below. Unknown metadata is preserved by
the registry, so adding metadata later does not change the execution API.

```js
const weatherTool = {
  name: 'weather',
  description: 'Get current weather',
  inputSchema: {
    type: 'object',
    properties: { city: { type: 'string' } },
    required: ['city'],
  },
  permissions: { network: true },
  async execute({ city }, context) {
    context.logger.info('weather:lookup', { city });
    return { city, temperature: 24 };
  },
};
```

The old `{ parameters, handler }` form remains accepted for compatibility with
existing built-ins. It is normalized to the same `execute(input, context)`
record and pipeline; it is not a second execution system.

## Registry and runner API

```js
agent.tools.register(weatherTool);
agent.tools.has('weather');
agent.tools.get('weather');
agent.tools.list();
agent.tools.unregister('weather');

const result = await agent.tools.run('weather', { city: 'Ilam' }, {
  timeout: 5000,
});

// Only the LLM-facing fields are returned; no implementation function leaks.
const definitions = agent.tools.getDefinitions();
```

`run()` returns the standard result shape:

```js
{ ok: true, data: { ... }, meta: { durationMs, source } }
{ ok: false, error: { code: 'TOOL_INVALID_INPUT', message: '...' }, meta: { ... } }
```

The legacy `agent.tools.execute()` method is a compatibility adapter that
returns the pre-existing top-level `code` and string `error` fields. New code
should use `run()`.

## Plugins

```js
const plugin = {
  name: 'my-plugin',
  metadata: { owner: 'team-a', version: '1.0.0' },
  tools: [weatherTool],
};

agent.tools.use(plugin);
agent.tools.removePlugin('my-plugin');
```

`listPlugins()` and `getPlugin()` expose plugin metadata and owned names. A
plugin does not receive an Agent or AgentLoop reference. Its tools receive only
`ToolContext`.

Static built-in factories are available from `src/tools/plugins/index.js` and
are mounted by `createDefaultToolRegistry()` using the same `use()` API. For
example, `createWebPlugin()` and `createFilePlugin()` produce ordinary plugin
objects. See `examples/custom-tool.js` for a complete custom Tool and plugin.

## Context, permissions and middleware

Tools should use the context boundary:

```js
async execute(input, context) {
  context.logger;
  context.config;
  context.memory;
  context.signal;
  context.capabilities;
}
```

Permission declarations can use the ranked object form or a compact list:

```js
permissions: { network: true, filesystem: false }
// or
permissions: ['process']
```

Permissions are checked before `execute`. `context.signal` is linked to both
the caller's `AbortSignal` and the runner timeout.

Middleware has the following contract:

```js
const audit = async (execution, next) => {
  const result = await next(execution);
  return result;
};
agent.tools.runner.use(audit);
```

Built-in runner middleware provides central validation, permission and timeout /
abort handling. Logging, retry, metrics, cache and audit middleware can be
added without modifying a Tool or AgentLoop.

## Error codes

The stable runner vocabulary is:

- `TOOL_NOT_FOUND`
- `TOOL_DISABLED`
- `TOOL_INVALID_INPUT`
- `TOOL_PERMISSION_DENIED`
- `TOOL_TIMEOUT`
- `TOOL_FAILED`
- `ABORTED`

A Tool may still return a domain-specific code when that is useful (for
example, `HTTP_STATUS`); it is wrapped in the same standard result shape.
