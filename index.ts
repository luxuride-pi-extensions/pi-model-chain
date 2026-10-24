/**
 * `openrouter-chain/chain` — one selectable model that is a fallback chain of physical models.
 *
 * The model is listed under its own provider id, `openrouter-chain`, rather than under
 * `openrouter`: the listing namespace names the router, not the vendor whose models it happens to
 * pick between, so `/model` does not suggest that `chain` is an OpenRouter model that exists
 * upstream. Every chain entry still belongs to `PROVIDER`, which is what the catalog lookups and
 * the routed requests use — a virtual model must return a physical model, and a physical model's
 * provider is the one that authenticates and streams it.
 *
 * Pi resolves `settings.defaultModel` by looking the id up in the catalog and checking provider
 * auth. When that lookup fails, `dist/core/model-resolver.js` falls through to
 * `defaultModelPerProvider[provider]`, which for openrouter is `moonshotai/kimi-k2.6`. The lookup
 * fails whenever the id is not in the catalog the runtime restored at startup — e.g. a persisted
 * personalized OpenRouter catalog in `models-store.json` that predates the model. A virtual model
 * is registered before initial model resolution, so a stale catalog can no longer decide the
 * session's model, and a model that fails at request time advances down the chain instead of
 * being retried.
 *
 * Routing rules:
 * - `continuation` / `direct`, and `user` in the same turn, stay on the model that last answered,
 *   so the provider prompt cache survives.
 * - `retry` after a failed request moves to the next chain entry; this is what makes the chain a
 *   *fallback* chain rather than the retry-same-model loop Pi does on its own.
 * - after a demotion the head is not retried until `DEMOTION_COOLDOWN_MS` has passed and a new
 *   user turn arrives, so a flapping provider cannot cost a fallback and a rollback per message.
 *
 * The routed model is the real catalog entry, so its `compat` — including `openRouterRouting` from
 * a `modelOverrides` entry in models.json — is what the request is built with.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
	ModelRoute,
	ModelRouteRequest,
} from "@earendil-works/pi-coding-agent";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

/** Provider every chain entry belongs to: the one that authenticates and streams the request. */
export const PROVIDER = "openrouter";

/**
 * Provider the virtual model is listed under. Distinct from `PROVIDER` on purpose: this is a
 * router namespace, and no such provider exists upstream. Pi synthesizes a credential-free
 * provider for an id nothing uses (`withVirtualModels`, dist/core/virtual-models.js), which is
 * safe here because every route still needs `PROVIDER` credentials.
 */
export const ROUTER_PROVIDER = "openrouter-chain";

/** Virtual model id, selected as `openrouter-chain/chain`. */
export const VIRTUAL_ID = "chain";

/**
 * Fallback order, preferred first. Only the first entry is one this extension claims as "the"
 * model; the rest are what it degrades to. Entries missing from the catalog are skipped.
 */
export const CHAIN: readonly string[] = [
	"deepseek/deepseek-v4.1-flash-1017",
	"deepseek/deepseek-v4.1-flash",
	"z-ai/glm-5.3-flash",
];

/** How long a demoted head stays demoted before a user turn tries it again. */
export const DEMOTION_COOLDOWN_MS = 10 * 60 * 1000;

export interface ChainState {
	/** Chain model currently in use. */
	model: string;
	/** When a failure demoted the head, so `model` is a fallback rather than a choice. */
	demotedAt?: number;
}

export function isChainModel(id: string | undefined): id is string {
	return id !== undefined && CHAIN.includes(id);
}

/** The chain entry is both in the chain and in the catalog. */
export function available(id: string | undefined, ctx: Pick<ExtensionContext, "modelRegistry">): boolean {
	if (!isChainModel(id)) return false;
	return ctx.modelRegistry.find(PROVIDER, id) !== undefined;
}

/** Preferred chain model that is in the catalog, or undefined when none is. */
export function chainHead(ctx: Pick<ExtensionContext, "modelRegistry">): string | undefined {
	return CHAIN.find((id) => available(id, ctx));
}

/** The chain entry after `id` that is in the catalog. */
export function chainNext(id: string | undefined, ctx: Pick<ExtensionContext, "modelRegistry">): string | undefined {
	const from = id === undefined ? 0 : CHAIN.indexOf(id) + 1;
	if (from <= 0) return chainHead(ctx);
	return CHAIN.slice(from).find((candidate) => available(candidate, ctx));
}

/**
 * The requested level, or the closest one the chosen physical model accepts. The chain's levels
 * are its intersection, but a session can still hold a level chosen on another model (e.g. `off`),
 * and glm-5.3-flash cannot disable thinking.
 */
export function clampLevel(model: { thinkingLevelMap?: Record<string, string | null> }, requested: ModelThinkingLevel): ModelThinkingLevel {
	const map = model.thinkingLevelMap;
	if (map === undefined) return requested;
	if (map[requested] !== null && map[requested] !== undefined) return requested;
	for (const candidate of ["high", "low", "max"] as const) {
		if (map[candidate] !== null && map[candidate] !== undefined) return candidate;
	}
	return requested;
}

function routeTo(
	request: ModelRouteRequest<ChainState>,
	ctx: Pick<ExtensionContext, "modelRegistry">,
	id: string,
	state?: ChainState,
): ModelRoute<ChainState> {
	const model = ctx.modelRegistry.find(PROVIDER, id);
	if (model === undefined) {
		throw new Error(`${ROUTER_PROVIDER}/${VIRTUAL_ID}: ${PROVIDER}/${id} is not in the catalog`);
	}
	return { model, thinkingLevel: clampLevel(model, request.thinkingLevel), state };
}

/**
 * The pure decision function: which chain entry serves this request, and the state to record.
 * Exported so it can be tested without a Pi session.
 */
export function choose(
	request: ModelRouteRequest<ChainState>,
	ctx: Pick<ExtensionContext, "modelRegistry">,
	now: number = Date.now(),
): { id: string; state: ChainState } {
	const state = request.state;
	const current = state?.model;
	const stick = request.reason === "continuation" || request.reason === "direct" || request.reason === "user";

	// Retry: the provider just failed this model, so hand the request to the next entry.
	if (request.reason === "retry") {
		const failedId = request.failed?.model.id;
		const fallback = chainNext(failedId, ctx) ?? (available(failedId, ctx) ? failedId : chainHead(ctx));
		if (fallback !== undefined) {
			return {
				id: fallback,
				state: { model: fallback, ...(fallback === CHAIN[0] ? {} : { demotedAt: now }) },
			};
		}
	}

	// A new user turn tries the head again once a demotion has aged out.
	if (request.reason === "user" && state?.demotedAt !== undefined && now - state.demotedAt > DEMOTION_COOLDOWN_MS) {
		const head = chainHead(ctx);
		if (head !== undefined) return { id: head, state: { model: head } };
	}

	// Everything else keeps the model that last answered.
	if (stick && available(current, ctx)) {
		return { id: current as string, state: state as ChainState };
	}

	const head = chainHead(ctx);
	if (head === undefined) {
		throw new Error(
			`${ROUTER_PROVIDER}/${VIRTUAL_ID}: none of ${CHAIN.join(", ")} is available on ${PROVIDER}`,
		);
	}
	return {
		id: head,
		state: { model: head, ...(state?.demotedAt !== undefined ? { demotedAt: state.demotedAt } : {}) },
	};
}

/**
 * Status-bar text, or undefined to clear it.
 *
 * Pi's built-in footer already appends `→ <routed model>` (`dist/modes/interactive/components/footer.js`),
 * but that text shares a line with token stats and the context meter, so at ~80 columns it is
 * truncated mid-id, and `routedModel` comes from `findLatestResponse()`, which skips `error` and
 * `aborted` responses — exactly when you most want to know which model was in play. This string
 * gets its own line, so it is never truncated and never disappears on failure.
 */
export function statusText(
	chainModel: string | undefined,
	outcome: Outcome | undefined,
	head: string | undefined,
): string | undefined {
	if (chainModel === undefined || outcome === undefined) {
		return head === undefined ? undefined : `chain • next up: ${shorten(head)}`;
	}
	// `pending` matters: a request in flight is not a failure, and saying "failed" while tokens are
	// still streaming would be worse than saying nothing.
	if (outcome === "pending") return `chain • → ${shorten(chainModel)}`;
	return outcome === "answered" ? `chain • served by: ${shorten(chainModel)}` : `chain • failed on: ${shorten(chainModel)}`;
}

/** Drop the vendor prefix and the redundant `deepseek-`, so `deepseek/deepseek-v4.1-flash-1017` fits. */
function shorten(id: string): string {
	const bare = id.includes("/") ? id.slice(id.indexOf("/") + 1) : id;
	return bare.startsWith("deepseek-deepseek-") ? bare.slice("deepseek-".length) : bare;
}

/** Where the latest request on the chain ended up. */
export type Outcome = "pending" | "answered" | "failed";

/** The chain model a failed request was on: `retry` carries it, a failed response may name it. */
function failureModel(request: { failed?: { model: { id: string } } }): string | undefined {
	const id = request.failed?.model.id;
	return id !== undefined && CHAIN.includes(id) ? id : undefined;
}

export default function (pi: ExtensionAPI) {
	/** Which chain entry the latest request/response used, and how it ended. */
	let observed: { model: string; outcome: Outcome } | undefined;

	const isChainSelected = (ctx: ExtensionContext): boolean =>
		ctx.model?.provider === ROUTER_PROVIDER && ctx.model.id === VIRTUAL_ID;

	const refresh = (ctx: ExtensionContext): void => {
		// `ui` is absent in headless contexts (SDK, some subagent runs); routing must not need it.
		const setStatus = ctx.ui?.setStatus;
		if (typeof setStatus !== "function") return;
		if (!isChainSelected(ctx)) {
			setStatus("chain", undefined);
			return;
		}
		// Startup: nothing has answered yet, so say what the next request will try.
		setStatus(
			"chain",
			statusText(observed?.model, observed?.outcome, observed === undefined ? chainHead(ctx) : undefined),
		);
	};

	pi.on("session_start", (_event, ctx) => refresh(ctx));
	pi.on("model_select", (_event, ctx) => {
		observed = undefined;
		refresh(ctx);
	});

	// Assistant messages name the physical model that actually produced them.
	pi.on("message_end", (event, ctx) => {
		const message = event.message;
		if (message.role !== "assistant" || !isChainSelected(ctx)) return;
		const id = (message as { model?: string }).model;
		const outcome: Outcome =
			message.stopReason === "error" || message.stopReason === "aborted" ? "failed" : "answered";
		if (id !== undefined) observed = { model: id, outcome };
		refresh(ctx);
	});

	// A retry runs before any response exists; record which model it is leaving so the status line
	// shows the failure instead of going blank.
	pi.on("turn_start", (_event, ctx) => refresh(ctx));

	pi.registerVirtualModel<ChainState>({
		provider: ROUTER_PROVIDER,
		id: VIRTUAL_ID,
		name: `OpenRouter chain (${CHAIN.join(" -> ")})`,
		// Intersection of the chain's supported levels, read from each entry's `thinkingLevelMap`:
		// the deepseek models allow `off` but reject `minimal`/`medium`/`xhigh`, and glm-5.3-flash
		// rejects `off` too. `off` is left out because glm cannot honour it; a session that still
		// holds the level (chosen on another model) gets it clamped by `clampLevel`.
		thinkingLevels: ["low", "high", "max"],
		// The chain's smallest limits, so the placeholder never advertises more than the model
		// that actually answers. After the first response Pi uses that model's own limits.
		contextWindow: 1_048_575,
		maxTokens: 393_216,
		route(request, ctx) {
			const { id, state } = choose(request, ctx);
			if (request.reason === "retry") {
				const leaving = failureModel(request);
				// Name the model being left until the new one produces something.
				if (leaving !== undefined) observed = { model: leaving, outcome: "failed" };
			}
			if (observed?.outcome !== "failed" || request.reason !== "retry") {
				observed = { model: id, outcome: "pending" };
			}
			refresh(ctx);
			return routeTo(request, ctx, id, state);
		},
	});
}
