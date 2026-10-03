import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MODEL_PRICING_ENV,
  loadOpenCodeModelPricing,
  resolveOpenCodeModelRates,
  resolveOpenCodeRunCost,
} from "./pricing.js";

const meteredUsage = {
  inputTokens: 100_000,
  cachedInputTokens: 4_000_000,
  outputTokens: 16_000,
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("resolveOpenCodeRunCost", () => {
  it("prices metered MiniMax-M3 from token usage when OpenCode reported 0", () => {
    const cost = resolveOpenCodeRunCost({
      model: "minimax-coding-plan/MiniMax-M3",
      ...meteredUsage,
      providerReportedCostUsd: 0,
    });
    expect(cost).not.toBeNull();
    expect(cost?.billingType).toBe("metered_api");
    expect(cost?.source).toBe("model_pricing");
    expect(cost?.costUsd).toBeCloseTo(0.1692, 10);
  });

  it("reproduces the ETQ-390 backfill arithmetic for a seeded row", () => {
    const cost = resolveOpenCodeRunCost({
      model: "minimax-coding-plan/MiniMax-M3",
      inputTokens: 358_892,
      cachedInputTokens: 1_078_784,
      outputTokens: 12_040,
      providerReportedCostUsd: 0,
    });
    expect(Math.ceil((cost?.costUsd ?? 0) * 100)).toBe(16);
  });

  it("keeps zero cost for subscription models", () => {
    for (const model of [
      "ollama/qwen3.5:2b-mlx",
      "opencode/mimo-v2.6-flash-free",
      "ollama/llama3.2",
      "opencode/longcat-2.5-preview-free",
      "opencode/space-bunny-free",
      "opencode/nemotron-3.5-lightning-free",
      "opencode/nemotron-3-ultra-free",
    ]) {
      const cost = resolveOpenCodeRunCost({
        model,
        inputTokens: 100_000,
        cachedInputTokens: 0,
        outputTokens: 5_000,
        providerReportedCostUsd: 0,
      });
      expect(cost?.costUsd).toBe(0);
      expect(cost?.billingType).toBe("subscription_included");
      expect(cost?.source).toBe("model_pricing");
    }
  });

  it("returns null for models without rates", () => {
    expect(
      resolveOpenCodeRunCost({
        model: "mimo/mimo-v2.6-flash",
        ...meteredUsage,
        providerReportedCostUsd: 0,
      }),
    ).toBeNull();
    expect(
      resolveOpenCodeRunCost({
        model: null,
        ...meteredUsage,
        providerReportedCostUsd: 0,
      }),
    ).toBeNull();
    expect(
      resolveOpenCodeRunCost({
        model: "",
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        providerReportedCostUsd: 0,
      }),
    ).toBeNull();
  });

  it("prefers a provider-reported cost", () => {
    const cost = resolveOpenCodeRunCost({
      model: "minimax-coding-plan/MiniMax-M3",
      ...meteredUsage,
      providerReportedCostUsd: 0.42,
    });
    expect(cost?.costUsd).toBe(0.42);
    expect(cost?.source).toBe("provider_reported");
    expect(cost?.billingType).toBe("metered_api");
  });

  it("has no price basis when a metered run reports no tokens", () => {
    expect(
      resolveOpenCodeRunCost({
        model: "minimax-coding-plan/MiniMax-M3",
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        providerReportedCostUsd: 0,
      }),
    ).toBeNull();
  });
});

describe("loadOpenCodeModelPricing", () => {
  it("mirrors every ai_model_pricing model id", () => {
    const pricing = loadOpenCodeModelPricing();
    for (const model of [
      "minimax-coding-plan/MiniMax-M3",
      "ollama/llama3.2",
      "ollama/qwen-arabic",
      "ollama/qwen2.5:1.5b",
      "ollama/qwen3.5:2b-mlx",
      "opencode/deepseek-v4-flash-free",
      "opencode/longcat-2.5-preview-free",
      "opencode/mimo-v2.6-flash-free",
      "opencode/nemotron-3-ultra-free",
      "opencode/nemotron-3.5-lightning-free",
      "opencode/space-bunny-free",
    ]) {
      expect(pricing[model], model).toBeDefined();
    }
    expect(pricing["minimax-coding-plan/MiniMax-M3"].inputCentsPer1k).toBe(0.03);
    expect(pricing["minimax-coding-plan/MiniMax-M3"].outputCentsPer1k).toBe(0.12);
    expect(pricing["minimax-coding-plan/MiniMax-M3"].cachedInputCentsPer1k).toBe(0.003);
  });

  it("lets PAPERCLIP_MODEL_PRICING_JSON override and extend rates", () => {
    vi.stubEnv(
      MODEL_PRICING_ENV,
      JSON.stringify({
        "minimax-coding-plan/MiniMax-M3": {
          billingType: "metered_api",
          inputCentsPer1k: 1,
          outputCentsPer1k: 2,
          cachedInputCentsPer1k: 3,
        },
        "vendor/new-model": {
          billingType: "metered_api",
          inputCentsPer1k: 10,
          outputCentsPer1k: 20,
          cachedInputCentsPer1k: 5,
        },
      }),
    );
    const pricing = loadOpenCodeModelPricing();
    expect(pricing["minimax-coding-plan/MiniMax-M3"].inputCentsPer1k).toBe(1);
    expect(pricing["vendor/new-model"]).toBeDefined();
    expect(pricing["ollama/llama3.2"], "fallback retained").toBeDefined();

    const cost = resolveOpenCodeRunCost({
      model: "minimax-coding-plan/MiniMax-M3",
      ...meteredUsage,
      providerReportedCostUsd: 0,
    });
    expect(cost?.costUsd).toBeCloseTo((100_000 * 1 + 4_000_000 * 3 + 16_000 * 2) / 100_000, 10);
  });

  it("ignores malformed overrides and falls back to the built-in rates", () => {
    vi.stubEnv(MODEL_PRICING_ENV, "{not json");
    expect(loadOpenCodeModelPricing()["minimax-coding-plan/MiniMax-M3"].inputCentsPer1k).toBe(0.03);

    vi.stubEnv(
      MODEL_PRICING_ENV,
      JSON.stringify({
        "minimax-coding-plan/MiniMax-M3": { billingType: "arbitrary", inputCentsPer1k: -1 },
        "vendor/new-model": { inputCentsPer1k: 1 },
      }),
    );
    const pricing = loadOpenCodeModelPricing();
    expect(pricing["minimax-coding-plan/MiniMax-M3"].inputCentsPer1k).toBe(0.03);
    expect(pricing["vendor/new-model"]).toBeUndefined();
  });

  it("resolves exact model ids only, trimming stray whitespace", () => {
    expect(resolveOpenCodeModelRates("mimo/mimo-v2.6-flash")).toBeNull();
    expect(resolveOpenCodeModelRates("hermes-agent")).toBeNull();
    expect(resolveOpenCodeModelRates(" opencode/mimo-v2.6-flash-free ")?.billingType).toBe(
      "subscription_included",
    );
  });
});

describe("opencode free-tier fallback coverage (ETQ-762)", () => {
  const freeTierModels = [
    "opencode/longcat-2.5-preview-free",
    "opencode/space-bunny-free",
    "opencode/nemotron-3.5-lightning-free",
    "opencode/nemotron-3-ultra-free",
  ];

  it("resolves rates for every opencode free-tier model in ai_model_pricing", () => {
    for (const model of freeTierModels) {
      const rates = resolveOpenCodeModelRates(model);
      expect(rates, model).not.toBeNull();
      expect(rates?.billingType, model).toBe("subscription_included");
      expect(rates?.inputCentsPer1k, model).toBe(0);
      expect(rates?.outputCentsPer1k, model).toBe(0);
      expect(rates?.cachedInputCentsPer1k, model).toBe(0);
    }
  });

  it("prices a step-finish with tokens as zero-cost subscription usage", () => {
    for (const model of freeTierModels) {
      const cost = resolveOpenCodeRunCost({
        model,
        inputTokens: 188_600,
        cachedInputTokens: 2_173_184,
        outputTokens: 15_439,
        providerReportedCostUsd: 0,
      });
      expect(cost, model).not.toBeNull();
      expect(cost?.costUsd, model).toBe(0);
      expect(cost?.billingType, model).toBe("subscription_included");
      expect(cost?.source, model).toBe("model_pricing");
    }
  });
});
