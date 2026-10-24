/**
 * Decision-table tests for `choose()`, the pure part of the router. No Pi session, no network:
 * the model registry is a stub that reports exactly the chain entries passed to it.
 */

import assert from "node:assert/strict";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
	CHAIN,
	clampLevel,
	DEMOTION_COOLDOWN_MS,
	PROVIDER,
	ROUTER_PROVIDER,
	VIRTUAL_ID,
	type ChainState,
	choose,
	statusText,
} from "../index.js";

type Registry = Pick<ExtensionContext, "modelRegistry">;

/** A registry that only knows `present` as catalog entries. */
function registry(...present: string[]): Registry {
	return {
		modelRegistry: {
			find: (provider: string, id: string) =>
				provider === "openrouter" && present.includes(id) ? ({ provider, id } as never) : undefined,
		} as Registry["modelRegistry"],
	};
}

const ALL = registry(...CHAIN);
const [HEAD, SECOND, THIRD] = CHAIN as [string, string, string];

/** A route request with the defaults the router ignores filled in. */
function request(
	reason: "user" | "continuation" | "retry" | "direct",
	extra: { state?: ChainState; failedId?: string } = {},
): Parameters<typeof choose>[0] {
	return {
		model: { id: "chain" } as never,
		thinkingLevel: "high",
		reason,
		messages: [],
		...(extra.state ? { state: extra.state } : {}),
		...(extra.failedId
			? { failed: { model: { id: extra.failedId } as never, message: { stopReason: "error" } as never } }
			: {}),
	};
}

const NOW = 1_000_000_000;
const cases: Array<[string, () => string, string]> = [
	// The chain, in order.
	["cold user turn takes the head", () => choose(request("user"), ALL, NOW).id, HEAD],
	["continuation keeps the answering model", () => choose(request("continuation", { state: { model: HEAD } }), ALL, NOW).id, HEAD],
	["direct keeps the answering model", () => choose(request("direct", { state: { model: SECOND } }), ALL, NOW).id, SECOND],

	// Falling back.
	["retry after the head fails moves to the second", () => choose(request("retry", { state: { model: HEAD }, failedId: HEAD }), ALL, NOW).id, SECOND],
	["retry after the second fails moves to the third", () => choose(request("retry", { state: { model: SECOND }, failedId: SECOND }), ALL, NOW).id, THIRD],
	["retry after the last entry stays on it", () => choose(request("retry", { state: { model: THIRD }, failedId: THIRD }), ALL, NOW).id, THIRD],
	["retry demotes", () => String(choose(request("retry", { state: { model: HEAD }, failedId: HEAD }), ALL, NOW).state.demotedAt !== undefined), "true"],
	["retry without known failure falls back to the head", () => choose(request("retry"), ALL, NOW).id, HEAD],

	// Staying demoted, then recovering.
	["continuation on a fallback stays on it", () => choose(request("continuation", { state: { model: SECOND, demotedAt: NOW } }), ALL, NOW).id, SECOND],
	["user turn inside the cooldown stays on the fallback", () => choose(request("user", { state: { model: SECOND, demotedAt: NOW } }), ALL, NOW).id, SECOND],
	["user turn after the cooldown returns to the head", () => choose(request("user", { state: { model: SECOND, demotedAt: NOW - DEMOTION_COOLDOWN_MS - 1 } }), ALL, NOW).id, HEAD],
	["recovery clears the demotion", () => String(choose(request("user", { state: { model: SECOND, demotedAt: NOW - DEMOTION_COOLDOWN_MS - 1 } }), ALL, NOW).state.demotedAt), "undefined"],

	// A chain entry that is not in the catalog is skipped, not selected.
	["head absent from the catalog", () => choose(request("user"), registry(SECOND, THIRD), NOW).id, SECOND],
	["only the last entry present", () => choose(request("user"), registry(THIRD), NOW).id, THIRD],
	["retry skips the absent second entry", () => choose(request("retry", { state: { model: HEAD }, failedId: HEAD }), registry(HEAD, THIRD), NOW).id, THIRD],
	["a state naming a model that left the catalog falls to the head", () => choose(request("continuation", { state: { model: SECOND } }), registry(HEAD), NOW).id, HEAD],

	// An empty catalog is an error, not a silent fallback.
	["empty catalog throws", () => {
		try {
			choose(request("user"), registry(), NOW);
			return "no throw";
		} catch (error) {
			return (error as Error).message;
		}
	}, `openrouter-chain/auto: none of ${CHAIN.join(", ")} is available on openrouter`],
];

let failed = 0;
for (const [name, run, expected] of cases) {
	const actual = run();
	if (actual === expected) {
		console.log(`ok   ${name}`);
	} else {
		failed += 1;
		console.error(`FAIL ${name}\n  expected ${expected}\n  actual   ${actual}`);
	}
}

// The registration the extension performs is separate from `choose()`; assert its shape too.
const registered: unknown[] = [];
const statuses: Array<string | undefined> = [];
const listeners = new Map<string, (event: unknown, ctx: unknown) => unknown>();
const { default: register } = await import("../index.js");
register({
	registerVirtualModel: (definition: unknown) => registered.push(definition),
	on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => listeners.set(name, handler),
} as never);
const definition = registered[0] as {
	provider: string;
	id: string;
	thinkingLevels: string[];
	contextWindow: number;
	maxTokens: number;
	route: (request: unknown, ctx: Registry) => { model: { id: string } };
};

const shape: Array<[string, unknown, unknown]> = [
	["registers exactly one model", registered.length, 1],
	// The listing namespace names the router; the catalog lookups use the vendor. They must differ,
	// or `/model` would imply `chain` is an OpenRouter model that exists upstream.
	["listed under the router namespace", definition.provider, "openrouter-chain"],
	["router namespace is not the vendor provider", `${PROVIDER}`, "openrouter"],
	["the id is auto", definition.id, "auto"],
	["thinking levels are the chain intersection", definition.thinkingLevels.join(","), "low,high,max"],
	// glm-5.3-flash cannot disable thinking; deepseek can.
	["clamp keeps a level the model supports", clampLevel({ thinkingLevelMap: { low: "low", high: "high" } }, "high"), "high"],
	["clamp moves an unsupported level to the nearest", clampLevel({ thinkingLevelMap: { off: null, low: "low", high: "high", max: "max" } }, "off"), "high"],
	["clamp leaves a mapless model alone", clampLevel({}, "off"), "off"],
	["limits are the chain minimum", `${definition.contextWindow}/${definition.maxTokens}`, "1048575/393216"],
	["route() returns the physical model", definition.route(request("user"), ALL).model.id, HEAD],

	// The status line has its own row, so it must stay short and survive a failure.
	["status names the next model before the first answer", statusText(undefined, undefined, HEAD), "chain • next up: deepseek-v4.1-flash-1017"],
	["status is silent when no chain entry is available", statusText(undefined, undefined, undefined), undefined],
	["status defers to the footer once a model answered", statusText(HEAD, "answered", undefined), undefined],
	["status still names the model after a failure", statusText(THIRD, "failed", undefined), "chain • failed on: glm-5.3-flash"],
	["status defers to the footer while a request is in flight", statusText(SECOND, "pending", undefined), undefined],
	["the status line is short enough for a footer row", String(visibleLength(statusText(CHAIN[2], "failed", undefined)) <= 44), "true"],
];
for (const [name, actual, expected] of shape) {
	if (actual === expected) {
		console.log(`ok   ${name}`);
	} else {
		failed += 1;
		console.error(`FAIL ${name}\n  expected ${String(expected)}\n  actual   ${String(actual)}`);
	}
}

function check(name: string, actual: unknown, expected: unknown): void {
	if (actual === expected) {
		console.log(`ok   ${name}`);
	} else {
		failed += 1;
		console.error(`FAIL ${name}\n  expected ${String(expected)}\n  actual   ${String(actual)}`);
	}
}

function visibleLength(text: string | undefined): number {
	return [...(text ?? "")].length;
}

// Event wiring: the status line must follow the physical model, and must be cleared for
// sessions that are not using the chain at all.
const chainCtx = { ...ALL, model: { provider: ROUTER_PROVIDER, id: VIRTUAL_ID }, ui: { setStatus: (_k: string, text: string | undefined) => statuses.push(text) } };
const otherCtx = { ...ALL, model: { provider: "openrouter", id: HEAD }, ui: { setStatus: (_k: string, text: string | undefined) => statuses.push(text) } };
const emit = (name: string, event: unknown, ctx: unknown) => listeners.get(name)?.(event, ctx);

// The shape checks above already routed once, so reset the observation first; at real startup
// nothing has been routed yet.
emit("model_select", { type: "model_select", model: chainCtx.model, previousModel: undefined, source: "restore" }, chainCtx);
statuses.length = 0;
emit("session_start", { type: "session_start" }, chainCtx);
check("session_start announces the next model", statuses.at(-1), "chain • next up: deepseek-v4.1-flash-1017");

statuses.length = 0;
emit("session_start", { type: "session_start" }, otherCtx);
check("a non-chain selection clears the status row", statuses.at(-1), undefined);

statuses.length = 0;
emit("message_end", { type: "message_end", message: { role: "assistant", model: HEAD, stopReason: "stop" } }, chainCtx);
check("a successful response leaves the row empty (footer has it)", statuses.at(-1), undefined);

statuses.length = 0;
emit("message_end", { type: "message_end", message: { role: "assistant", model: SECOND, stopReason: "error" } }, chainCtx);
check("a failed response names the model it failed on", statuses.at(-1), "chain • failed on: deepseek-v4.1-flash");

if (failed > 0) {
	console.error(`\n${failed} assertion(s) failed`);
	process.exit(1);
}
console.log(`\nall ${cases.length + shape.length + 4} assertions passed`);
