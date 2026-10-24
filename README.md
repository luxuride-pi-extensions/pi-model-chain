# pi-model-chain

Pi extension: one selectable model, `openrouter-chain/chain`, that is a fallback chain of physical
OpenRouter models.

```text
deepseek/deepseek-v4.1-flash-1017  ->  deepseek/deepseek-v4.1-flash  ->  z-ai/glm-5.3-flash
```

Set it as the default and pi has a defined answer for "the preferred model is unavailable":

```json
{
  "defaultProvider": "openrouter-chain",
  "defaultModel": "chain"
}
```

The selection is recorded as `openrouter-chain/chain`; each assistant message names the physical model
that actually answered, so the transcript stays honest about what ran.

## Why `openrouter-chain/chain` and not `openrouter/chain`

The listing namespace names the *router*, not the vendor whose models it picks between, so
`/model` does not suggest that `chain` is an OpenRouter model that exists upstream. Two constants:

- `ROUTER_PROVIDER = "openrouter-chain"` — where the virtual model is listed. No provider exists
  under that id; Pi synthesizes a credential-free one for it (`withVirtualModels` in
  `dist/core/virtual-models.js`), which is safe because every route still needs real credentials.
- `PROVIDER = "openrouter"` — the vendor every chain entry belongs to, used for the catalog lookup
  and therefore for the request that gets streamed.

A virtual model must return a *physical* model, and a physical model's provider is the one that
authenticates and streams it, so `PROVIDER` cannot be replaced by the router namespace. If the chain
ever spans providers, `PROVIDER` stops being enough on its own and `CHAIN` decisions must carry a
provider per entry — the constant is the place that change starts.

## Why this exists

Pi picks the initial model in `dist/core/model-resolver.js` in this order:

1. `settings.defaultModel`, **if** the id is in the catalog and the provider has auth;
2. otherwise `defaultModelPerProvider[provider]` — for openrouter, `moonshotai/kimi-k2.6`;
3. otherwise the first available model.

Step 1 fails whenever the id is not in the catalog the runtime restored at startup. A persisted
personalized OpenRouter catalog in `~/.pi/agent/models-store.json` *replaces* the builtin one
rather than extending it, and `sdk.js` builds the runtime without network access, so the initial
model is resolved against a snapshot that can be older than the model you configured. The visible
symptom is a fresh session that quietly starts on kimi-k2.6, plus a
`Could not restore model <provider>/<id>` fallback message.

A virtual model is registered before that resolution runs, so a stale catalog can no longer decide
the session's model. `pi update --models` fixes the stale snapshot; this extension makes the
resolution robust either way, and adds the fallback behaviour `settings.retry` cannot express —
`retry` re-sends the *same* model.

## Routing rules

| Request reason | Route |
| --- | --- |
| `user` (cold session) | first chain model present in the catalog |
| `continuation`, `direct` | the model that answered last, so the provider prompt cache survives |
| `user` (same turn, inside the cooldown) | the model that answered last |
| `retry` (the model just failed) | the next chain entry that is in the catalog |
| `user` (after `DEMOTION_COOLDOWN_MS`) | the head again |

A demoted head is not retried for 10 minutes, so a flapping provider cannot cost a fallback and a
rollback on every message. A chain entry that is missing from the catalog is skipped, never
selected; an empty catalog throws instead of silently picking something else.

## Configure

Everything is in `index.ts`:

- **`CHAIN`** — the fallback order, preferred first. Only the first entry is "the" model; the rest
  are what it degrades to. Adding, removing or reordering entries changes the behaviour; no other
  code assumes three entries.
- **`DEMOTION_COOLDOWN_MS`** — how long a demoted head stays demoted. Set `0` to retry the head on
  every new user message.
- **`thinkingLevels`** — `["low", "high", "max"]` is the intersection of the chain's supported
  levels: both deepseek entries reject `off` and `medium`, and glm-5.3-flash has no `xhigh`. If you
  add a model with a narrower set, narrow this too.
- **`contextWindow` / `maxTokens`** — the chain's smallest limits, used only until the first
  response, after which Pi uses the answering model's own limits.

`provider` is fixed to `openrouter`, and a chain entry must belong to it.

## modelOverrides still apply

Yes. The router returns the real catalog model from `ctx.modelRegistry.find()`, not a synthesized
one, so `compat` — including `openRouterRouting` from a `modelOverrides` entry in `models.json` —
is what the request is built with. `openai-completions` sends it verbatim:

```js
model.compat?.openRouterRouting && (params.provider = model.compat.openRouterRouting)
```

So a per-model `openRouterRouting` override, thinking format, or reasoning-content requirement
follows the physical model that was routed to, whichever one that is. This is verifiable end to
end: set `only: ["no-such-provider-xyz"]` on the head model and the chain's first request fails
with OpenRouter's own `No allowed providers are available ... your request's provider.only
preference permits only: no-such-provider-xyz`, which is the override arriving intact.

## Subagents

Foreground (in-process) children do not load the parent's ambient extensions, so a child pointed at
`openrouter-chain/chain` sends that raw id to OpenRouter and gets
`400: chain is not a valid model ID`. Give children the extension explicitly:

```json
{
  "subagents": {
    "defaultModel": "openrouter-chain/chain",
    "defaultSubagentOnlyExtensions": ["/home/you/.pi/agent/extensions/model-chain/index.ts"]
  }
}
```

A background child (`async: true`) loads ambient extensions already and needs no such entry.

## Install

```bash
pi install git:github.com/luxuride-pi-extensions/pi-model-chain
```

or symlink it next to your other extensions:

```bash
ln -s /path/to/pi-model-chain ~/.pi/agent/extensions/model-chain
```

Then set `defaultModel` to `chain` (or select `openrouter-chain/chain` with `/model`).

## Development

```bash
npm install --legacy-peer-deps   # peerDependencies are not on npm
npm run typecheck
npm test                         # 23 assertions over the routing decision table
```

`choose()` is exported and pure: it takes a request, a registry stub and a timestamp, so the whole
decision table is testable without a session or a network.

## Licence

MIT
