import { EMPTY_USAGE, type UsageTotals } from "../../usage.js";
import type {
  RuntimePrompt,
  RuntimeRunRequest,
  RuntimeRunResult,
  RuntimeTool,
} from "../../runtimes/types.js";
import type { NormalizedAgentErrorCode } from "../contracts/domain.js";

type OpenRouterUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  cost?: number;
  prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
};

type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

type OpenRouterMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: unknown }
  | { role: "assistant"; content: string; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; name: string; content: string };

export type OpenRouterProviderPolicy = Readonly<{
  allowFallbacks: boolean;
  order?: readonly string[];
  requireParameters?: boolean;
  dataCollection?: "allow" | "deny";
  only?: readonly string[];
  ignore?: readonly string[];
}>;

export type OpenRouterBudget = Readonly<{
  timeoutMs: number;
  maxToolRounds: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  maxTotalTokens?: number;
  maxCostUsd?: number;
}>;

export type OpenRouterReasoningEffort = "max" | "xhigh" | "high" | "medium" | "low" | "minimal" | "none";

export type OpenRouterRunOptions = Readonly<{
  fallbackModels?: readonly string[];
  provider?: OpenRouterProviderPolicy;
  budget: OpenRouterBudget;
  parallelToolCalls?: boolean;
  toolChoice?: "auto" | "none" | "required";
  maxTokens?: number;
  temperature?: number;
  /** OpenRouter-only reasoning level. Kept separate from Codex runtime effort. */
  reasoningEffort?: OpenRouterReasoningEffort;
  metadata?: Record<string, string | number | boolean>;
  sessionId?: string;
  /** End deterministically after executing the requested tools; avoids a cosmetic second model call. */
  stopAfterToolResult?: boolean;
  onEvent?: (event: OpenRouterRuntimeEvent) => void | Promise<void>;
}>;

export type OpenRouterRuntimeEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_call"; toolName: string; input: Record<string, unknown> }
  | { type: "tool_result"; toolName: string; success: boolean }
  | { type: "usage"; usage: OpenRouterDetailedUsage }
  | { type: "transport_started"; operation: string; attempt: number }
  | { type: "transport_response"; operation: string; attempt: number; status: number; latencyMs: number }
  | { type: "transport_retry"; operation: string; attempt: number; status: number }
  | { type: "transport_failed"; operation: string; phase: OpenRouterFailurePhase; timeoutKind?: OpenRouterTimeoutKind };

export type OpenRouterFailurePhase = "connect" | "provider" | "generation" | "runtime" | "cancellation";
export type OpenRouterTimeoutKind = "connect" | "provider" | "generation" | "runtime";

export type OpenRouterObservation = Readonly<{
  operation: "chat.completions";
  outcome: "success" | "error" | "timeout" | "cancelled";
  phase?: OpenRouterFailurePhase;
  timeoutKind?: OpenRouterTimeoutKind;
  requestedModel: string;
  resolvedModel?: string;
  provider?: string;
  latencyMs: number;
  attempts: number;
  status?: number;
  errorCode?: NormalizedAgentErrorCode;
  occurredAt: number;
}>;

export type OpenRouterDetailedUsage = Readonly<{
  requestedModel: string;
  resolvedModel: string;
  provider?: string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  fallbackUsed: boolean;
}>;

export interface OpenRouterRuntimeResult extends RuntimeRunResult {
  runtime: "openrouter";
  requestedModel: string;
  resolvedModel: string;
  provider?: string;
  finishReason?: string;
  latencyMs: number;
  detailedUsage: OpenRouterDetailedUsage;
  toolResults: readonly Readonly<{ toolName: string; text: string; success: boolean }>[];
}

export class OpenRouterRuntimeError extends Error {
  constructor(
    message: string,
    public readonly code: NormalizedAgentErrorCode,
    public readonly retryable: boolean,
    public readonly status?: number,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "OpenRouterRuntimeError";
  }
}

export type OpenRouterAdapterConfig = Readonly<{
  apiKey: string;
  baseUrl?: string;
  siteUrl?: string;
  appName?: string;
  maxTransportRetries?: number;
  fetch?: typeof fetch;
  onObservation?: (observation: OpenRouterObservation) => void;
}>;

type StreamResult = {
  text: string;
  toolCalls: ToolCall[];
  usage: OpenRouterUsage;
  model: string;
  provider?: string;
  finishReason?: string;
  attempts: number;
};

function promptContent(prompt: RuntimePrompt): unknown {
  if (typeof prompt === "string") return prompt;
  return prompt.map((block) =>
    block.type === "text"
      ? { type: "text", text: block.text }
      : { type: "image_url", image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` } },
  );
}

function runtimeToolName(tool: RuntimeTool, index: number): string {
  const normalized = `${tool.namespace}__${tool.name}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 56);
  return `${normalized}_${index}`;
}

function configuredTools(request: RuntimeRunRequest) {
  const handlers = new Map<string, RuntimeTool>();
  const definitions: Array<Record<string, unknown>> = [];
  const allowed = request.allowedTools ? new Set(request.allowedTools) : null;
  const disallowed = new Set(request.disallowedTools ?? []);
  for (const [index, tool] of request.tools.entries()) {
    const fullName = `${tool.namespace}.${tool.name}`;
    if (disallowed.has(tool.name) || disallowed.has(fullName)) continue;
    if (allowed && !allowed.has(tool.name) && !allowed.has(fullName)) continue;
    const name = runtimeToolName(tool, index);
    handlers.set(name, tool);
    definitions.push({
      type: "function",
      // Provider-level strict mode requires every property to be required on
      // OpenAI-compatible providers, which is incompatible with useful optional
      // filters. Runtime Zod remains strict and rejects unknown/invalid fields.
      function: { name, description: tool.description, parameters: tool.jsonSchema },
    });
  }
  return { definitions, handlers };
}

function errorCode(status: number): { code: NormalizedAgentErrorCode; retryable: boolean } {
  if (status === 429) return { code: "RATE_LIMITED", retryable: true };
  if ([408, 502, 503, 504].includes(status)) return { code: "PROVIDER_UNAVAILABLE", retryable: true };
  if ([401, 403].includes(status)) return { code: "PERMISSION_DENIED", retryable: false };
  return { code: "PROVIDER_UNAVAILABLE", retryable: status >= 500 };
}

function createAbortScope(parent: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(parent?.reason ?? new Error("cancelled"));
  parent?.addEventListener("abort", abortFromParent, { once: true });
  const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", abortFromParent);
    },
  };
}

async function waitForRetry(response: Response, attempt: number): Promise<void> {
  const retryAfter = Number(response.headers.get("retry-after"));
  const delay = Number.isFinite(retryAfter) && retryAfter > 0
    ? Math.min(retryAfter * 1_000, 10_000)
    : Math.min(250 * 2 ** attempt, 2_000);
  await new Promise((resolve) => setTimeout(resolve, delay));
}

export class OpenRouterAdapter {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: OpenRouterAdapterConfig) {
    if (!config.apiKey.trim()) throw new Error("OpenRouter apiKey is required");
    this.fetchImpl = config.fetch ?? fetch;
  }

  async run(request: RuntimeRunRequest, options: OpenRouterRunOptions): Promise<OpenRouterRuntimeResult> {
    if (!request.model.trim()) throw new Error("OpenRouter request.model must be configured by RuntimeConfig");
    if (options.budget.maxToolRounds < 0 || options.budget.timeoutMs <= 0) throw new Error("Invalid OpenRouter budget");

    const startedAt = Date.now();
    const { definitions, handlers } = configuredTools(request);
    const messages: OpenRouterMessage[] = [
      { role: "system", content: request.systemPrompt },
      { role: "user", content: promptContent(request.prompt) },
    ];
    const abortScope = createAbortScope(request.abortController?.signal, options.budget.timeoutMs);
    let text = "";
    let finishReason: string | undefined;
    let provider: string | undefined;
    let resolvedModel = request.model;
    let aggregate: OpenRouterUsage = {};
    let attempts = 0;
    const toolResults: Array<{ toolName: string; text: string; success: boolean }> = [];

    try {
      for (let round = 0; round <= options.budget.maxToolRounds; round += 1) {
        if (abortScope.signal.aborted) throw this.abortError(request.abortController?.signal.aborted ?? false, "runtime", request.model);
        const stream = await this.streamCompletion(request, options, messages, definitions, abortScope.signal);
        attempts += stream.attempts;
        resolvedModel = stream.model || resolvedModel;
        provider = stream.provider || provider;
        finishReason = stream.finishReason || finishReason;
        aggregate = mergeRawUsage(aggregate, stream.usage);
        this.assertBudget(request.model, resolvedModel, provider, aggregate, options.budget);
        await options.onEvent?.({ type: "usage", usage: detailedUsage(request.model, resolvedModel, provider, aggregate) });

        if (stream.text) text += stream.text;
        messages.push({ role: "assistant", content: stream.text, ...(stream.toolCalls.length ? { tool_calls: stream.toolCalls } : {}) });
        if (stream.toolCalls.length === 0) break;
        if (round === options.budget.maxToolRounds && !options.stopAfterToolResult) {
          throw new OpenRouterRuntimeError("OpenRouter tool round budget exceeded", "BUDGET_EXCEEDED", false);
        }

        const executeCall = async (call: ToolCall): Promise<OpenRouterMessage> => {
          const tool = handlers.get(call.function.name);
          if (!tool) throw new OpenRouterRuntimeError(`Unknown tool requested: ${call.function.name}`, "INVALID_TOOL_CALL", false);
          let args: Record<string, unknown>;
          try {
            args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
          } catch {
            throw new OpenRouterRuntimeError(`Invalid JSON for tool ${tool.name}`, "INVALID_TOOL_CALL", false);
          }
          await request.onToolUse?.(tool.name, args);
          await options.onEvent?.({ type: "tool_call", toolName: tool.name, input: args });
          let result;
          try {
            result = await tool.handle(args);
          } catch (error) {
            throw new OpenRouterRuntimeError(`Tool ${tool.name} validation or execution failed`, "INVALID_TOOL_CALL", false, undefined, { cause: String(error) });
          }
          await request.onToolResult?.(tool.name, result.text);
          await options.onEvent?.({ type: "tool_result", toolName: tool.name, success: result.success !== false });
          toolResults.push({ toolName: tool.name, text: result.text, success: result.success !== false });
          return { role: "tool", tool_call_id: call.id, name: call.function.name, content: result.text };
        };

        const toolMessages = options.parallelToolCalls
          ? await Promise.all(stream.toolCalls.map(executeCall))
          : await stream.toolCalls.reduce<Promise<OpenRouterMessage[]>>(async (prior, call) => [...(await prior), await executeCall(call)], Promise.resolve([]));
        messages.push(...toolMessages);
        if (options.stopAfterToolResult) break;
      }
    } catch (error) {
      if (abortScope.signal.aborted && !(error instanceof OpenRouterRuntimeError)) {
        const aborted = this.abortError(request.abortController?.signal.aborted ?? false, "runtime", request.model);
        this.observeFailure(aborted, request.model, startedAt, attempts || 1);
        throw aborted;
      }
      if (error instanceof OpenRouterRuntimeError) this.observeFailure(error, request.model, startedAt, attempts || 1);
      throw error;
    } finally {
      abortScope.dispose();
    }

    const details = detailedUsage(request.model, resolvedModel, provider, aggregate);
    const usage: UsageTotals = {
      ...EMPTY_USAGE,
      model: resolvedModel,
      inputTokens: details.inputTokens,
      outputTokens: details.outputTokens,
      cacheReadTokens: details.cachedTokens,
      cacheCreationTokens: details.cacheWriteTokens,
      costUsd: details.costUsd,
    };
    await request.onUsage?.(usage);
    this.config.onObservation?.({
      operation: "chat.completions", outcome: "success", requestedModel: request.model,
      resolvedModel, provider, latencyMs: Date.now() - startedAt, attempts: Math.max(attempts, 1), occurredAt: Date.now(),
    });
    return {
      runtime: "openrouter",
      text,
      usage,
      requestedModel: request.model,
      resolvedModel,
      provider,
      finishReason,
      latencyMs: Date.now() - startedAt,
      detailedUsage: details,
      toolResults: Object.freeze([...toolResults]),
    };
  }

  private abortError(cancelledByParent: boolean, timeoutKind: OpenRouterTimeoutKind, requestedModel: string): OpenRouterRuntimeError {
    return new OpenRouterRuntimeError(
      cancelledByParent ? "OpenRouter request cancelled" : "OpenRouter request timed out",
      cancelledByParent ? "CANCELLED" : "TIMEOUT",
      !cancelledByParent,
      undefined,
      { operation: "chat.completions", phase: cancelledByParent ? "cancellation" : timeoutKind, timeoutKind: cancelledByParent ? undefined : timeoutKind, requestedModel },
    );
  }

  private observeFailure(error: OpenRouterRuntimeError, requestedModel: string, startedAt: number, attempts: number): void {
    const phase = (error.details?.phase as OpenRouterFailurePhase | undefined) ?? (error.code === "CANCELLED" ? "cancellation" : "runtime");
    const timeoutKind = error.details?.timeoutKind as OpenRouterTimeoutKind | undefined;
    this.config.onObservation?.({
      operation: "chat.completions",
      outcome: error.code === "TIMEOUT" ? "timeout" : error.code === "CANCELLED" ? "cancelled" : "error",
      phase, timeoutKind, requestedModel,
      resolvedModel: typeof error.details?.resolvedModel === "string" ? error.details.resolvedModel : undefined,
      provider: typeof error.details?.provider === "string" ? error.details.provider : undefined,
      latencyMs: Date.now() - startedAt, attempts, status: error.status, errorCode: error.code, occurredAt: Date.now(),
    });
  }

  private async streamCompletion(
    request: RuntimeRunRequest,
    options: OpenRouterRunOptions,
    messages: OpenRouterMessage[],
    toolDefinitions: Array<Record<string, unknown>>,
    signal: AbortSignal,
  ): Promise<StreamResult> {
    const fallbackModels = [...new Set(options.fallbackModels ?? [])].filter((model) => model !== request.model);
    const provider = options.provider ?? { allowFallbacks: fallbackModels.length > 0 };
    const body = {
      ...(fallbackModels.length ? { models: [request.model, ...fallbackModels] } : { model: request.model }),
      messages,
      stream: true,
      stream_options: { include_usage: true },
      provider: {
        allow_fallbacks: provider.allowFallbacks,
        ...(provider.order ? { order: [...provider.order] } : {}),
        ...(provider.only ? { only: [...provider.only] } : {}),
        ...(provider.ignore ? { ignore: [...provider.ignore] } : {}),
        ...(provider.requireParameters !== undefined ? { require_parameters: provider.requireParameters } : {}),
        ...(provider.dataCollection ? { data_collection: provider.dataCollection } : {}),
      },
      parallel_tool_calls: options.parallelToolCalls ?? false,
      ...((options.reasoningEffort ?? request.reasoningEffort)
        ? { reasoning: { effort: options.reasoningEffort ?? request.reasoningEffort } }
        : {}),
      ...(options.maxTokens ? { max_tokens: options.maxTokens } : {}),
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(options.metadata ? { metadata: options.metadata } : {}),
      ...(options.sessionId ? { session_id: options.sessionId } : {}),
      ...(toolDefinitions.length ? { tools: toolDefinitions, tool_choice: options.toolChoice ?? "auto" } : {}),
    };

    const maxRetries = Math.max(0, this.config.maxTransportRetries ?? 2);
    let response: Response | undefined;
    let attemptsMade = 0;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      attemptsMade = attempt + 1;
      const transportStartedAt = Date.now();
      if (options.onEvent) await options.onEvent({ type: "transport_started", operation: "chat.completions", attempt: attempt + 1 });
      try {
        response = await this.fetchImpl(this.config.baseUrl ?? "https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.config.apiKey}`,
            "content-type": "application/json",
            ...(this.config.siteUrl ? { "http-referer": this.config.siteUrl } : {}),
            ...(this.config.appName ? { "x-title": this.config.appName } : {}),
          },
          signal,
          body: JSON.stringify(body),
        });
      } catch (error) {
        if (signal.aborted) {
          const timeout = this.abortError(request.abortController?.signal.aborted ?? false, "connect", request.model);
          await options.onEvent?.({ type: "transport_failed", operation: "chat.completions", phase: request.abortController?.signal.aborted ? "cancellation" : "connect", timeoutKind: request.abortController?.signal.aborted ? undefined : "connect" });
          throw timeout;
        }
        throw new OpenRouterRuntimeError("OpenRouter connection failed", "PROVIDER_UNAVAILABLE", true, undefined, {
          operation: "chat.completions", phase: "connect", cause: error instanceof Error ? error.name : "unknown",
        });
      }
      await options.onEvent?.({ type: "transport_response", operation: "chat.completions", attempt: attempt + 1, status: response.status, latencyMs: Date.now() - transportStartedAt });
      if (response.ok) break;
      const classification = errorCode(response.status);
      if (!classification.retryable || attempt === maxRetries) {
        const details = (await response.text()).slice(0, 2_000);
        const providerTimeout = [408, 504].includes(response.status);
        throw new OpenRouterRuntimeError(`OpenRouter request failed (${response.status})`, classification.code, classification.retryable, response.status, {
          response: details, operation: "chat.completions", phase: "provider", ...(providerTimeout ? { timeoutKind: "provider" } : {}),
        });
      }
      await options.onEvent?.({ type: "transport_retry", operation: "chat.completions", attempt: attempt + 1, status: response.status });
      await waitForRetry(response, attempt);
    }
    if (!response?.ok) throw new OpenRouterRuntimeError("OpenRouter did not return a response", "PROVIDER_UNAVAILABLE", true);
    try {
      return { ...(await readStream(response, request, options)), attempts: Math.max(1, attemptsMade) };
    } catch (error) {
      if (signal.aborted && !(error instanceof OpenRouterRuntimeError)) {
        const timeout = this.abortError(request.abortController?.signal.aborted ?? false, "generation", request.model);
        await options.onEvent?.({ type: "transport_failed", operation: "chat.completions", phase: request.abortController?.signal.aborted ? "cancellation" : "generation", timeoutKind: request.abortController?.signal.aborted ? undefined : "generation" });
        throw timeout;
      }
      if (error instanceof OpenRouterRuntimeError) {
        throw new OpenRouterRuntimeError(error.message, error.code, error.retryable, error.status, {
          ...error.details, operation: "chat.completions", phase: "generation",
        });
      }
      throw error;
    }
  }

  private assertBudget(requestedModel: string, resolvedModel: string, provider: string | undefined, usage: OpenRouterUsage, budget: OpenRouterBudget): void {
    const details = detailedUsage(requestedModel, resolvedModel, provider, usage);
    if (budget.maxInputTokens !== undefined && details.inputTokens > budget.maxInputTokens) throw new OpenRouterRuntimeError("Input token budget exceeded", "BUDGET_EXCEEDED", false);
    if (budget.maxOutputTokens !== undefined && details.outputTokens > budget.maxOutputTokens) throw new OpenRouterRuntimeError("Output token budget exceeded", "BUDGET_EXCEEDED", false);
    if (budget.maxTotalTokens !== undefined && details.inputTokens + details.outputTokens > budget.maxTotalTokens) throw new OpenRouterRuntimeError("Total token budget exceeded", "BUDGET_EXCEEDED", false);
    if (budget.maxCostUsd !== undefined && details.costUsd > budget.maxCostUsd) throw new OpenRouterRuntimeError("Cost budget exceeded", "BUDGET_EXCEEDED", false);
  }
}

function mergeRawUsage(total: OpenRouterUsage, next: OpenRouterUsage): OpenRouterUsage {
  return {
    prompt_tokens: (total.prompt_tokens ?? 0) + (next.prompt_tokens ?? 0),
    completion_tokens: (total.completion_tokens ?? 0) + (next.completion_tokens ?? 0),
    cost: (total.cost ?? 0) + (next.cost ?? 0),
    prompt_tokens_details: {
      cached_tokens: (total.prompt_tokens_details?.cached_tokens ?? 0) + (next.prompt_tokens_details?.cached_tokens ?? 0),
      cache_write_tokens: (total.prompt_tokens_details?.cache_write_tokens ?? 0) + (next.prompt_tokens_details?.cache_write_tokens ?? 0),
    },
    completion_tokens_details: {
      reasoning_tokens: (total.completion_tokens_details?.reasoning_tokens ?? 0) + (next.completion_tokens_details?.reasoning_tokens ?? 0),
    },
  };
}

function detailedUsage(requestedModel: string, resolvedModel: string, provider: string | undefined, usage: OpenRouterUsage): OpenRouterDetailedUsage {
  return {
    requestedModel,
    resolvedModel,
    provider,
    inputTokens: usage.prompt_tokens ?? 0,
    outputTokens: usage.completion_tokens ?? 0,
    reasoningTokens: usage.completion_tokens_details?.reasoning_tokens ?? 0,
    cachedTokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
    cacheWriteTokens: usage.prompt_tokens_details?.cache_write_tokens ?? 0,
    costUsd: usage.cost ?? 0,
    fallbackUsed: requestedModel !== resolvedModel,
  };
}

async function readStream(response: Response, request: RuntimeRunRequest, options: OpenRouterRunOptions): Promise<Omit<StreamResult, "attempts">> {
  if (!response.body) throw new OpenRouterRuntimeError("OpenRouter returned an empty response body", "PROVIDER_UNAVAILABLE", true);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let model = "";
  let provider: string | undefined;
  let finishReason: string | undefined;
  let usage: OpenRouterUsage = {};
  const partialCalls = new Map<number, ToolCall>();

  const consumeLine = async (line: string) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") return;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      throw new OpenRouterRuntimeError("OpenRouter emitted invalid SSE JSON", "PROVIDER_UNAVAILABLE", true);
    }
    if (event.error) throw new OpenRouterRuntimeError("OpenRouter stream error", "PROVIDER_UNAVAILABLE", true, undefined, { error: event.error });
    if (typeof event.model === "string") model = event.model;
    if (typeof event.provider === "string") provider = event.provider;
    if (event.usage) usage = event.usage as OpenRouterUsage;
    const choice = (event.choices as Array<Record<string, unknown>> | undefined)?.[0];
    if (typeof choice?.finish_reason === "string") finishReason = choice.finish_reason;
    const delta = choice?.delta as { content?: string | null; tool_calls?: Array<{ index: number; id?: string; type?: "function"; function?: { name?: string; arguments?: string } }> } | undefined;
    if (typeof delta?.content === "string") {
      text += delta.content;
      await request.onText?.(delta.content);
      await options.onEvent?.({ type: "text_delta", text: delta.content });
    }
    for (const part of delta?.tool_calls ?? []) {
      const current = partialCalls.get(part.index) ?? { id: part.id ?? `openrouter_tool_${part.index}`, type: "function" as const, function: { name: "", arguments: "" } };
      if (part.id) current.id = part.id;
      if (part.function?.name) current.function.name += part.function.name;
      if (part.function?.arguments) current.function.arguments += part.function.arguments;
      partialCalls.set(part.index, current);
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) await consumeLine(line);
    if (done) break;
  }
  if (buffer.trim()) await consumeLine(buffer);
  return { text, toolCalls: [...partialCalls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call), usage, model, provider, finishReason };
}
