import { test } from "node:test";
import assert from "node:assert/strict";
import { Agent } from "../src/agent.js";
import { getCacheWriteRate, getModelPricing } from "../src/ui.js";

test("MiniMax model parameters", () => {
  const m3Pricing = getModelPricing("MiniMax-M3");
  assert.deepEqual(m3Pricing, {
    input: 0.6,
    output: 2.4,
    cacheRead: 0.12,
    cacheWrite: null,
  });
  assert.equal(getCacheWriteRate(m3Pricing), 0.6);
  assert.deepEqual(getModelPricing("MiniMax-M2.7"), {
    input: 0.3,
    output: 1.2,
    cacheRead: 0.06,
    cacheWrite: 0.375,
  });

  const m3: any = new Agent({ apiKey: "test-key", model: "MiniMax-M3", thinking: true });
  assert.equal(m3.effectiveWindow, 980000);
  assert.equal(m3.thinkingMode, "adaptive");
  m3.totalInputTokens = 1_000_000;
  m3.totalOutputTokens = 1_000_000;
  m3.totalCacheReadTokens = 1_000_000;
  m3.totalCacheCreationTokens = 1_000_000;
  assert.ok(Math.abs(m3.getCurrentCostUsd() - 3.72) < 1e-12);

  const m3Disabled: any = new Agent({ apiKey: "test-key", model: "MiniMax-M3" });
  assert.equal(m3Disabled.thinkingMode, "disabled");

  const m27: any = new Agent({ apiKey: "test-key", model: "MiniMax-M2.7" });
  assert.equal(m27.effectiveWindow, 184800);
  assert.equal(m27.thinkingMode, "enabled");
  m27.totalInputTokens = 1_000_000;
  m27.totalOutputTokens = 1_000_000;
  m27.totalCacheReadTokens = 1_000_000;
  m27.totalCacheCreationTokens = 1_000_000;
  assert.ok(Math.abs(m27.getCurrentCostUsd() - 1.935) < 1e-12);
});
