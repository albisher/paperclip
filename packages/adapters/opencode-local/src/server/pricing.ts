export type OpenCodeBillingType = "metered_api" | "subscription_included";

export interface OpenCodeModelRates {
  billingType: OpenCodeBillingType;
  inputCentsPer1k: number;
  outputCentsPer1k: number;
  cachedInputCentsPer1k: number;
}

export const MODEL_PRICING_ENV = "PAPERCLIP_MODEL_PRICING_JSON";

const FALLBACK_MODEL_PRICING: Readonly<Record<string, OpenCodeModelRates>> = Object.freeze({
  "minimax-coding-plan/MiniMax-M3": {
    billingType: "metered_api",
    inputCentsPer1k: 0.03,
    outputCentsPer1k: 0.12,
    cachedInputCentsPer1k: 0.003,
  },
  "ollama/llama3.2": {
    billingType: "subscription_included",
    inputCentsPer1k: 0,
    outputCentsPer1k: 0,
    cachedInputCentsPer1k: 0,
  },
  "ollama/qwen-arabic": {
    billingType: "subscription_included",
    inputCentsPer1k: 0,
    outputCentsPer1k: 0,
    cachedInputCentsPer1k: 0,
  },
  "ollama/qwen2.5:1.5b": {
    billingType: "subscription_included",
    inputCentsPer1k: 0,
    outputCentsPer1k: 0,
    cachedInputCentsPer1k: 0,
  },
  "ollama/qwen3.5:2b-mlx": {
    billingType: "subscription_included",
    inputCentsPer1k: 0,
    outputCentsPer1k: 0,
    cachedInputCentsPer1k: 0,
  },
  "opencode/deepseek-v4-flash-free": {
    billingType: "subscription_included",
    inputCentsPer1k: 0,
    outputCentsPer1k: 0,
    cachedInputCentsPer1k: 0,
  },
  "opencode/mimo-v2.6-flash-free": {
    billingType: "subscription_included",
    inputCentsPer1k: 0,
    outputCentsPer1k: 0,
    cachedInputCentsPer1k: 0,
  },
});

function finiteRate(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function normalizeRates(value: unknown): OpenCodeModelRates | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const input = finiteRate(record.inputCentsPer1k);
  const output = finiteRate(record.outputCentsPer1k);
  const cachedInput = finiteRate(record.cachedInputCentsPer1k);
  if (input === null || output === null || cachedInput === null) return null;
  const billingType = record.billingType;
  if (billingType !== "metered_api" && billingType !== "subscription_included") return null;
  return { billingType, inputCentsPer1k: input, outputCentsPer1k: output, cachedInputCentsPer1k: cachedInput };
}

export function loadOpenCodeModelPricing(): Readonly<Record<string, OpenCodeModelRates>> {
  const raw = process.env[MODEL_PRICING_ENV];
  if (!raw) return FALLBACK_MODEL_PRICING;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return FALLBACK_MODEL_PRICING;
  }
  if (typeof parsed !== "object" || parsed === null) return FALLBACK_MODEL_PRICING;
  const merged: Record<string, OpenCodeModelRates> = { ...FALLBACK_MODEL_PRICING };
  for (const [model, value] of Object.entries(parsed as Record<string, unknown>)) {
    const rates = normalizeRates(value);
    if (model.trim() && rates) merged[model] = rates;
  }
  return merged;
}

export function resolveOpenCodeModelRates(model: string | null | undefined): OpenCodeModelRates | null {
  const key = typeof model === "string" ? model.trim() : "";
  if (!key) return null;
  return loadOpenCodeModelPricing()[key] ?? null;
}

export interface OpenCodeRunCost {
  costUsd: number;
  billingType: OpenCodeBillingType;
  source: "provider_reported" | "model_pricing";
}

export function resolveOpenCodeRunCost(input: {
  model: string | null | undefined;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  providerReportedCostUsd: number | null | undefined;
}): OpenCodeRunCost | null {
  const reported = input.providerReportedCostUsd;
  const reportedUsd = typeof reported === "number" && Number.isFinite(reported) && reported > 0 ? reported : null;
  const rates = resolveOpenCodeModelRates(input.model);
  if (!rates) return null;

  if (reportedUsd !== null) return { costUsd: reportedUsd, billingType: rates.billingType, source: "provider_reported" };
  if (rates.billingType === "subscription_included") {
    return { costUsd: 0, billingType: "subscription_included", source: "model_pricing" };
  }

  const inputTokens = Math.max(0, input.inputTokens);
  const cachedInputTokens = Math.max(0, input.cachedInputTokens);
  const outputTokens = Math.max(0, input.outputTokens);
  if (inputTokens + cachedInputTokens + outputTokens === 0) return null;

  const costUsd =
    (inputTokens * rates.inputCentsPer1k +
      cachedInputTokens * rates.cachedInputCentsPer1k +
      outputTokens * rates.outputCentsPer1k) /
    100_000;
  return { costUsd, billingType: rates.billingType, source: "model_pricing" };
}
