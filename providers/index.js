"use strict";

/**
 * providers/index.js — V2 slice 1 loader.
 *
 * Single-entry registry for now. Slice 2 adds OpenAI; slice 3 adds Codex.
 * Loader contract (slice 1):
 *   loadProvider(id) -> { id, fetchUsage, fetchCostReport, countTokens }
 *   listProviders()  -> ['anthropic']
 *
 * The shape of fetchUsage / fetchCostReport / countTokens is unchanged from
 * the legacy in-audit.js implementations — slice 1 is pure extraction, no
 * normalisation, no interface widening. Renames (fetchAnthropicUsage ->
 * fetchUsage) are confined inside the plugin module; audit.js call sites
 * keep their existing names via thin wrappers.
 */

const REGISTRY = {
  anthropic: () => require("./anthropic/billing.js"),
};

function loadProvider(id) {
  const factory = REGISTRY[id];
  if (!factory) {
    throw new Error(`Unknown provider: ${id}. Known: ${listProviders().join(", ")}`);
  }
  return factory();
}

function listProviders() {
  return Object.keys(REGISTRY);
}

module.exports = { loadProvider, listProviders };
