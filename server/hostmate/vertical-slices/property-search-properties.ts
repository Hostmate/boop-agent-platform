import { createHash, randomUUID } from "node:crypto";
import type { ActorContext } from "../contracts/actor-context.js";
import type { EntityRef } from "../contracts/domain.js";
import type { ExecutionResult } from "../contracts/execution-result.js";
import type { AgentMessageRecord, ControlPlaneRepository, ConversationContextRefs } from "../control-plane/repository.js";
import { redactEventPayload } from "../events/contracts.js";
import { ExecutionDispatchResolver } from "../interaction/dispatch.js";
import { DefaultPolicyEngine } from "../policy/engine.js";
import { ExecutionProfileRegistry } from "../profiles/registry.js";
import {
  PROPERTY_GET_PROPERTY_TOOL_ID,
  createPropertyGetPropertyTool,
  toPropertyGetExecutionResult,
  type PropertyDetailPort,
  type PropertyGetPropertyOutput,
  type PropertyGetPropertyInput,
} from "../product-tools/property/get-property.js";
import {
  PROPERTY_SEARCH_PROPERTIES_TOOL_ID,
  createPropertySearchPropertiesTool,
  toPropertySearchExecutionResult,
  type PropertySearchFilters,
  type PropertySearchPort,
  type PropertySearchPropertiesOutput,
} from "../product-tools/property/search-properties.js";
import { OpenRouterAdapter, OpenRouterRuntimeError, type OpenRouterReasoningEffort, type OpenRouterRuntimeResult } from "../runtime/openrouter-adapter.js";
import { SkillRegistry } from "../skills/registry.js";
import { ProductToolRegistry } from "../tools/registry.js";
import type { PropertyOrderRecall } from "../memory/repository.js";
import { explicitPropertyOrder } from "../memory/policy.js";
import {
  isPropertyDetailIntent,
  isPropertyIdentificationIntent,
  propertyAmbiguityQuestion,
  propertyCandidatesBlock,
  propertyGroundingCandidatesFromBlock,
  resolvePropertyMention,
  type PropertyGroundingCandidate,
} from "../interaction/property-grounding.js";

export type PropertySearchPropertiesSliceConfig = Readonly<{
  model: string;
  fallbackModels?: readonly string[];
  reasoningEffort?: OpenRouterReasoningEffort;
  timeoutMs?: number;
  maxCostUsd?: number;
  weakPreference?: PropertyOrderRecall;
}>;

export type PropertySearchTurnResult = Readonly<{
  conversationId: string;
  interactionRunId: string;
  executionRunId?: string;
  result: ExecutionResult<PropertySearchPropertiesOutput | PropertyGetPropertyOutput>;
  runtime?: OpenRouterRuntimeResult;
}>;

function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function normalize(value: string): string { return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9€]+/g, " ").replace(/\s+/g, " ").trim(); }
function compactNumbers(value: string): string { return value.replace(/(?<=\d)[.,\s](?=\d{3}(?:\D|$))/g, ""); }

function containsValue(objective: string, value: string | undefined): boolean {
  return Boolean(value && ` ${normalize(objective)} `.includes(` ${normalize(value)} `));
}

function hasNumber(objective: string, value: number | undefined): boolean {
  return value != null && new RegExp(`(^|\\D)${String(value).replace(".", "[.,]")}($|\\D)`).test(compactNumbers(objective));
}

function exactCountEvidence(objective: string, value: number | undefined, nouns: string): boolean {
  if (value == null || !hasNumber(objective, value)) return false;
  const text = normalize(compactNumbers(objective));
  const n = String(value);
  const near = new RegExp(`(?:\\b${n}\\b.{0,24}\\b(?:${nouns})\\b|\\b(?:${nouns})\\b.{0,24}\\b${n}\\b)`).test(text);
  const comparative = new RegExp(`(?:al menos|minimo|minima|como minimo|mas de|desde).{0,24}\\b${n}\\b.{0,24}\\b(?:${nouns})\\b`).test(text)
    || new RegExp(`(?:maximo|maxima|como maximo|menos de|hasta).{0,24}\\b${n}\\b.{0,24}\\b(?:${nouns})\\b`).test(text);
  return near && !comparative;
}

const TYPE_EVIDENCE: Record<string, readonly string[]> = {
  piso: ["piso", "pisos", "apartamento", "apartamentos", "apto", "aptos"],
  casa: ["casa", "casas", "chalet", "chalets", "villa", "villas"],
  atico: ["atico", "aticos", "penthouse"], duplex: ["duplex"], estudio: ["estudio", "estudios"],
  loft: ["loft", "lofts"], local_comercial: ["local", "locales", "local comercial"],
  oficina: ["oficina", "oficinas"], nave_industrial: ["nave", "naves", "nave industrial"],
  parcela: ["parcela", "parcelas", "terreno", "terrenos", "solar", "solares"],
  edificio: ["edificio", "edificios"], garaje: ["garaje", "garajes"],
};

const FEATURE_EVIDENCE: Record<string, readonly string[]> = {
  exterior: ["exterior"], ascensor: ["ascensor"], garaje: ["garaje", "parking"], piscina: ["piscina"],
  jardin: ["jardin"], terraza: ["terraza"], aire_acondicionado: ["aire acondicionado", "a c"],
  trastero: ["trastero"], a_reformar: ["a reformar"], reformado: ["reformado", "reformada"],
  amueblado: ["amueblado", "amueblada"], balcon: ["balcon"],
};

function evidenceForAny(objective: string, values: readonly string[]): boolean {
  const text = ` ${normalize(objective)} `;
  return values.some((value) => text.includes(` ${normalize(value)} `));
}

function explicitPropertyType(objective: string): string | undefined {
  const matches = Object.entries(TYPE_EVIDENCE)
    .filter(([, evidence]) => evidenceForAny(objective, evidence))
    .map(([propertyType]) => propertyType);
  return matches.length === 1 ? matches[0] : undefined;
}

/** Removes every optional model proposal that is not evidenced by the user objective. */
export function bindPropertyFiltersToObjective(input: PropertySearchFilters, objective: string, weakOrder?: "price_asc" | "price_desc" | "newest"): PropertySearchFilters {
  const text = normalize(objective);
  const operation = input.operation && (input.operation === "comprar"
    ? evidenceForAny(objective, ["comprar", "compra", "venta", "en venta"])
    : evidenceForAny(objective, ["alquilar", "alquiler", "arrendar", "renta"])) ? input.operation : undefined;
  const typeEvidence = input.propertyType
    ? TYPE_EVIDENCE[normalize(input.propertyType)] ?? [input.propertyType]
    : [];
  const propertyType = input.propertyType && evidenceForAny(objective, typeEvidence)
    ? input.propertyType
    : explicitPropertyType(objective);
  const statusEvidence: Record<string, readonly string[]> = {
    activo: ["activo", "activos", "disponible", "disponibles"], reservado: ["reservado", "reservados"],
    vendido: ["vendido", "vendidos"], alquilado: ["alquilado", "alquilados"], desactivado: ["desactivado", "desactivados", "archivado", "archivados"],
  };
  const numberText = compactNumbers(objective);
  const betweenPrices = /\bentre\b/.test(text);
  const minPrice = input.minPrice != null && hasNumber(numberText, input.minPrice)
    && (betweenPrices || /\b(desde|a partir de|minimo|minima|mas de|por encima de)\b/.test(text)) ? input.minPrice : undefined;
  const maxPrice = input.maxPrice != null && hasNumber(numberText, input.maxPrice)
    && (betweenPrices || /\b(hasta|maximo|maxima|menos de|por debajo de|como mucho)\b/.test(text)) ? input.maxPrice : undefined;
  const areaEvidence = /\b(m2|metros cuadrados|superficie)\b/.test(text);
  const minArea = input.minArea != null && hasNumber(numberText, input.minArea) && areaEvidence
    && /\b(desde|a partir de|minimo|minima|mas de|por encima de|entre)\b/.test(text) ? input.minArea : undefined;
  const maxArea = input.maxArea != null && hasNumber(numberText, input.maxArea) && areaEvidence
    && /\b(hasta|maximo|maxima|menos de|por debajo de|como mucho|entre)\b/.test(text) ? input.maxArea : undefined;
  const features = input.features?.filter((feature) => evidenceForAny(objective, FEATURE_EVIDENCE[feature] ?? [feature]));
  // The current request is authoritative. A recalled preference is only a
  // weak allowlisted default when the user did not specify an order now.
  const order = explicitPropertyOrder(objective) ?? weakOrder;
  return propertySearchPropertiesInputCleanup({
    query: containsValue(objective, input.query) ? input.query : undefined,
    city: containsValue(objective, input.city) ? input.city : undefined,
    neighborhood: containsValue(objective, input.neighborhood) ? input.neighborhood : undefined,
    operation,
    propertyType,
    status: input.status && evidenceForAny(objective, statusEvidence[input.status] ?? [input.status]) ? input.status : undefined,
    minPrice, maxPrice,
    rooms: exactCountEvidence(objective, input.rooms, "habitacion|habitaciones|dormitorio|dormitorios") ? input.rooms : undefined,
    bathrooms: exactCountEvidence(objective, input.bathrooms, "bano|banos") ? input.bathrooms : undefined,
    minArea, maxArea, features: features?.length ? features : undefined, order,
  });
}

function propertySearchPropertiesInputCleanup(value: PropertySearchFilters): PropertySearchFilters {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as PropertySearchFilters;
}

function latestContext(messages: readonly AgentMessageRecord[]): ConversationContextRefs {
  for (const message of [...messages].reverse()) if (message.contextRefs) return message.contextRefs;
  return { selected: {}, referenced: [] };
}

function latestPropertyItem(messages: readonly AgentMessageRecord[], id: string) {
  for (const message of [...messages].reverse()) {
    for (const block of [...(message.blocks ?? [])].reverse()) {
      if (block.type === "entity_detail" && block.ref.type === "property.property" && block.ref.id === id) {
        return { ref: block.ref, title: block.title, subtitle: block.subtitle, imageUrl: block.imageUrl, fields: block.sections.flatMap((section) => section.fields) };
      }
      if (block.type === "entity_list") {
        const item = block.items.find((candidate) => candidate.ref.type === "property.property" && candidate.ref.id === id);
        if (item) return item;
      }
    }
  }
  return undefined;
}

function selectedProperty(messages: readonly AgentMessageRecord[]): EntityRef | undefined {
  const ref = latestContext(messages).selected.property;
  return ref?.type === "property.property" ? ref : undefined;
}

function isDetailIntent(message: string): boolean { return isPropertyDetailIntent(message); }

function isComposedSearchDetail(message: string): boolean {
  const value = normalize(message);
  return /\b(busca|buscar|encuentra|encontrar|muestra|muestrame|lista)\b/.test(value)
    && /\b(detalle|detalles|cuentame mas|informacion completa|ficha completa)\b/.test(value);
}

function isDeterministicOrderedDetail(message: string, output: PropertySearchPropertiesOutput): boolean {
  const value = normalize(message);
  return output.matches.length > 0 && (
    output.appliedFilters.order === "price_asc" || output.appliedFilters.order === "price_desc" || output.appliedFilters.order === "newest"
    || /\b(mas barato|mas baratos|mas caro|mas caros|barato|caro|reciente|recientes)\b/.test(value)
  );
}

function propertyCandidatesFromOutput(output: PropertySearchPropertiesOutput): readonly PropertyGroundingCandidate[] {
  const block = toPropertySearchExecutionResult(output).blocks?.find((candidate): candidate is Extract<NonNullable<ExecutionResult["blocks"]>[number], { type: "entity_list" }> => candidate.type === "entity_list");
  return block ? propertyGroundingCandidatesFromBlock(block) : [];
}

function sanitizedDetailEvent(output: PropertyGetPropertyOutput) {
  return {
    ref: output.ref,
    reference: output.reference,
    title: output.title,
    status: output.status,
    price: output.price,
    currency: output.currency,
    location: output.location,
    specifications: output.specifications,
    features: output.features,
    imageCount: output.images.length,
    associatedAgentCount: output.associatedAgents.length,
  };
}

export class PropertySearchPropertiesVerticalSlice {
  constructor(
    private readonly repository: ControlPlaneRepository,
    private readonly propertySearch: PropertySearchPort,
    private readonly propertyDetail: PropertyDetailPort,
    private readonly runtime: OpenRouterAdapter,
    private readonly config: PropertySearchPropertiesSliceConfig,
  ) {
    if (!config.model.trim()) throw new Error("Property read model must come from runtime configuration");
  }

  async execute(actor: ActorContext, input: { conversationId: string; message: string; selectedEntityRef?: EntityRef; requestId?: string; abortController?: AbortController }): Promise<PropertySearchTurnResult> {
    const message = input.message.trim();
    if (!message || message.length > 500) throw new Error("Message must contain between 1 and 500 characters");
    const interactionRunId = randomUUID();
    let priorMessages: readonly AgentMessageRecord[];
    try { priorMessages = await this.repository.listMessages(actor, { conversationId: input.conversationId, limit: 200 }); }
    catch { await this.repository.createConversation(actor, { conversationId: input.conversationId, title: "AI Chat" }); priorMessages = []; }
    let context = latestContext(priorMessages);
    let sequence = (priorMessages.at(-1)?.sequence ?? 0) + 1;
    const selectedInput = input.selectedEntityRef?.type === "property.property" ? input.selectedEntityRef : undefined;
    const selectedItem = selectedInput ? latestPropertyItem(priorMessages, selectedInput.id) : undefined;
    const staleSelection = Boolean(selectedInput && !selectedItem);
    if (selectedItem) context = { selected: { ...context.selected, property: selectedItem.ref }, referenced: context.referenced };
    await this.repository.appendMessage(actor, {
      messageId: randomUUID(), conversationId: input.conversationId, role: "user", contentRedacted: message,
      contextRefs: context, sequence: sequence++, createdAt: Date.now(),
    });

    let eventSequence = 0;
    let executionRunId: string | undefined;
    let attemptId: string | undefined;
    const event = async (
      type: string,
      payload: unknown,
      linkage: "current" | "interaction" | "execution" = "current",
    ): Promise<void> => {
      await this.repository.appendEvent(actor, {
        eventId: randomUUID(), conversationId: input.conversationId, interactionRunId,
        executionRunId: linkage === "interaction" ? undefined : executionRunId,
        attemptId: linkage === "current" ? attemptId : undefined,
        sequence: ++eventSequence, type, visibility: "user", payload: redactEventPayload(payload), occurredAt: Date.now(),
      });
    };
    await this.repository.createRun(actor, {
      runId: interactionRunId, conversationId: input.conversationId, kind: "interaction", objectiveHash: hash(message),
      objectiveRedacted: message.slice(0, 240), dependencyRunIds: [], registryHash: "interaction-dispatch-v3",
      skillVersions: {}, toolScope: [], visibility: "user",
    });
    await this.repository.updateRun(actor, interactionRunId, { status: "running" }, "queued");
    await event("interaction.started", { profile: "property", objective: message.slice(0, 240) });

    if (staleSelection) {
      const result: ExecutionResult<PropertySearchPropertiesOutput | PropertyGetPropertyOutput> = {
        status: "permission_denied", summary: "Ese inmueble no está disponible dentro de los resultados visibles de esta conversación.",
        entities: [], errors: [{ code: "STALE_REFERENCE", message: "Property selection has no authorized conversation provenance", retryable: false }],
      };
      await event("interaction.selection.denied", { role: "property", inputRef: selectedInput, provenance: "missing", reason: "stale_reference", inferenceCount: 0 });
      await this.repository.updateRun(actor, interactionRunId, { status: "completed", resultSummary: result.summary, completedAt: Date.now() }, "running");
      await this.persistAssistant(actor, input.conversationId, sequence, undefined, result, context);
      return { conversationId: input.conversationId, interactionRunId, result };
    }

    const currentProperty = selectedProperty(priorMessages);
    const grounding = resolvePropertyMention({ message, messages: priorMessages, selected: currentProperty });
    if (grounding?.kind === "ambiguous") {
      const result: ExecutionResult<PropertySearchPropertiesOutput | PropertyGetPropertyOutput> = {
        status: "needs_input", summary: grounding.question, entities: grounding.candidates.map((candidate) => candidate.ref),
        blocks: [propertyCandidatesBlock(grounding.candidates)],
        errors: [{ code: "AMBIGUOUS", message: "Several authorized property candidates match the user's description.", retryable: false }],
        suggestedNext: [grounding.question],
      };
      await event("interaction.property_ambiguous", {
        reason: grounding.reason, candidateRefs: grounding.candidates.map((candidate) => candidate.ref), inferenceCount: 0,
      });
      await this.repository.updateRun(actor, interactionRunId, { status: "completed", resultSummary: result.summary, completedAt: Date.now() }, "running");
      await this.persistAssistant(actor, input.conversationId, sequence, undefined, result, context);
      return { conversationId: input.conversationId, interactionRunId, result };
    }
    const groundedRef = grounding?.kind === "resolved" ? grounding.ref : undefined;
    const detailRef = selectedItem?.ref ?? groundedRef ?? (currentProperty && isDetailIntent(message) ? currentProperty : undefined);
    const composed = !detailRef && isComposedSearchDetail(message);
    const identificationAfterSearch = !detailRef && isPropertyIdentificationIntent(message) && isPropertyDetailIntent(message);
    const needsDetailAfterSearch = composed || identificationAfterSearch;
    if (!detailRef && !composed && isDetailIntent(message)) {
      const result: ExecutionResult<PropertySearchPropertiesOutput | PropertyGetPropertyOutput> = {
        status: "needs_input",
        summary: "Necesito que selecciones un inmueble concreto antes de mostrar su detalle.",
        entities: [], errors: [], suggestedNext: ["Selecciona uno de los inmuebles de una búsqueda anterior."],
      };
      await event("interaction.needs_selection", { role: "property", reason: "ambiguous_property_detail", inferenceCount: 0 });
      await this.repository.updateRun(actor, interactionRunId, { status: "completed", resultSummary: result.summary, completedAt: Date.now() }, "running");
      await this.persistAssistant(actor, input.conversationId, sequence, undefined, result, context);
      return { conversationId: input.conversationId, interactionRunId, result };
    }

    if (detailRef) {
      await event("interaction.selection.updated", {
        role: "property", inputRef: detailRef, provenance: selectedItem ? "explicit_conversation_result" : "selected_context", inferenceCount: 0,
      });
      executionRunId = randomUUID();
      attemptId = randomUUID();
      return this.executeDirectDetail({ actor, input, message, interactionRunId, executionRunId, attemptId, sequence, context, detailRef, event });
    }

    let output: PropertySearchPropertiesOutput | undefined;
    let detailOutput: PropertyGetPropertyOutput | undefined;
    let requestedToolInput: Record<string, unknown> | undefined;
    let sanitizedToolInput: PropertySearchFilters | undefined;
    let preferenceApplicationLatencyMs = 0;
    const boundPort: PropertySearchPort = {
      search: (boundActor, modelInput) => {
        const preferenceApplicationStartedAt = performance.now();
        sanitizedToolInput = bindPropertyFiltersToObjective(modelInput, message, this.config.weakPreference?.order);
        preferenceApplicationLatencyMs = performance.now() - preferenceApplicationStartedAt;
        return this.propertySearch.search(boundActor, sanitizedToolInput);
      },
    };
    const searchTool = createPropertySearchPropertiesTool({ port: boundPort, onResult: (result) => { output = result; } });
    const detailTool = createPropertyGetPropertyTool({ port: this.propertyDetail, onResult: (result) => { detailOutput = result; } });
    const toolRegistry = new ProductToolRegistry([searchTool, detailTool]);
    const allowedToolIds = needsDetailAfterSearch ? [PROPERTY_SEARCH_PROPERTIES_TOOL_ID, PROPERTY_GET_PROPERTY_TOOL_ID] : [PROPERTY_SEARCH_PROPERTIES_TOOL_ID];
    const objectiveCapabilities = needsDetailAfterSearch ? ["property.property.search", "property.property.read"] : ["property.property.search"];
    const dispatch = new ExecutionDispatchResolver(new ExecutionProfileRegistry(), toolRegistry, new SkillRegistry()).resolve({
      actor, allowedToolIds, featureEnabled: (toolId) => allowedToolIds.includes(toolId),
      request: {
        profileId: "property", objective: message, objectiveClasses: needsDetailAfterSearch ? ["property.search", "property.lookup"] : ["property.search"], objectiveCapabilities,
        inputRefs: [], dependencyRunIds: [], internalSkillHints: [], constraints: { readOnly: true, maxResults: 6 },
      },
    });
    const toolScope = dispatch.toolResolution.tools.map((tool) => `${tool.toolId}@${tool.version}`);
    await event("interaction.dispatch.resolved", { profile: "property", profileVersion: dispatch.profile.version, toolScope, skillVersions: {}, inputRefs: [] });
    await this.repository.updateRun(actor, interactionRunId, { status: "completed", resultSummary: "Dispatched property search", completedAt: Date.now() }, "running");

    executionRunId = randomUUID();
    attemptId = randomUUID();
    await this.repository.createRun(actor, {
      runId: executionRunId, conversationId: input.conversationId, kind: "execution", profileId: "property", profileVersion: dispatch.profile.version,
      objectiveHash: dispatch.objectiveHash, objectiveRedacted: message.slice(0, 240), parentRunId: interactionRunId,
      dependencyRunIds: [], registryHash: dispatch.toolResolution.registryHash, skillVersions: {}, toolScope,
      requestedModel: this.config.model, visibility: "user",
    });
    if (dispatch.toolResolution.tools.length !== allowedToolIds.length) {
      const result: ExecutionResult<PropertySearchPropertiesOutput | PropertyGetPropertyOutput> = {
        status: "permission_denied", summary: "No tienes permiso para consultar inmuebles en este contexto.", entities: [],
        errors: [{ code: "PERMISSION_DENIED", message: dispatch.toolResolution.rejected[0]?.reason ?? "Tool unavailable", retryable: false }],
      };
      await this.repository.updateRun(actor, executionRunId, { status: "failed", errorCode: "PERMISSION_DENIED", resultSummary: result.summary, completedAt: Date.now() }, "queued");
      await event("execution.permission_denied", { rejected: dispatch.toolResolution.rejected }, "execution");
      await this.persistAssistant(actor, input.conversationId, sequence, executionRunId, result, context);
      return { conversationId: input.conversationId, interactionRunId, executionRunId, result };
    }

    await this.repository.createAttempt(actor, { attemptId, runId: executionRunId, attemptNumber: 1, status: "queued", fencingToken: 0 });
    await this.repository.updateAttempt(actor, { attemptId, expectedStatus: "queued", patch: { status: "running", startedAt: Date.now() } });
    await this.repository.updateRun(actor, executionRunId, { status: "running" }, "queued");
    await event("execution.started", { profile: "property", profileVersion: dispatch.profile.version, requestedModel: this.config.model });
    if (this.config.weakPreference) {
      const recalled = this.config.weakPreference;
      await event("memory.preference.applied", {
        memoryId: recalled.record.memoryId, category: recalled.record.category,
        preferenceKey: recalled.record.preferenceKey, value: recalled.order,
        retrievalMode: recalled.mode, score: recalled.score, authority: "weak_user_preference",
      });
      if (recalled.embedding) {
        await this.repository.recordUsage(actor, {
          usageId: randomUUID(), runId: executionRunId, attemptId,
          requestedModel: recalled.embedding.model, resolvedModel: recalled.embedding.model,
          provider: recalled.embedding.provider, inputTokens: recalled.embedding.inputTokens,
          outputTokens: 0, reasoningTokens: 0, cachedTokens: 0, costUsd: recalled.embedding.costUsd,
          latencyMs: recalled.latencyMs, fallbackUsed: false, finishReason: "embedding", createdAt: Date.now(),
        });
      }
    }
    const runtimeTools = toolRegistry.compileRuntimeTools({
      resolved: dispatch.toolResolution, actor, policy: new DefaultPolicyEngine(), profileId: "property",
      decisionId: () => randomUUID(), hasRequiredPreconditions: () => true,
    });
    const searchRuntimeTools = runtimeTools.filter((tool) => tool.namespace === "property" && tool.name === "search_properties");

    let runtime: OpenRouterRuntimeResult | undefined;
    try {
      await event("tool.requested", { toolId: PROPERTY_SEARCH_PROPERTIES_TOOL_ID, version: 1 });
      await event("model.started", { requestedModel: this.config.model, provider: "openrouter", reasoningEffort: this.config.reasoningEffort, inference: 1 });
      runtime = await this.runtime.run({
        prompt: message, abortController: input.abortController,
        systemPrompt: [
          "You are a scoped Hostmate property catalog search execution agent.",
          "Call property.search_properties exactly once. Use only fields in its schema.",
          "Every optional filter must be explicitly evidenced in the user's words; omit assumptions and product defaults.",
          "rooms and bathrooms are exact-only. Never convert 'at least' or 'at most' into an exact count.",
          "Never invent tenant, actor, status, operation, type, price, city, features, ordering, IDs or pagination.",
        ].join("\n"),
        model: this.config.model, mode: "execution", tools: [...searchRuntimeTools], allowedTools: ["property.search_properties"],
        onToolUse: async (toolName, toolInput) => { requestedToolInput = toolInput as Record<string, unknown>; await event("tool.started", { toolName, inputRequested: toolInput }); },
        onToolResult: async (toolName) => await event("tool.completed", {
          toolName, service: "property.service.list", inputRequested: requestedToolInput, inputSanitized: sanitizedToolInput,
          latencyMs: output?.telemetry?.latencyMs, preferenceApplicationLatencyMs, resultCount: output?.returned, total: output?.total,
          entityRefs: output?.matches.map((property) => property.ref),
        }),
      }, {
        fallbackModels: this.config.fallbackModels,
        reasoningEffort: this.config.reasoningEffort,
        budget: { timeoutMs: this.config.timeoutMs ?? 30_000, maxToolRounds: 0, maxCostUsd: this.config.maxCostUsd ?? 0.05 },
        parallelToolCalls: false, toolChoice: "required", stopAfterToolResult: true,
        metadata: { interaction_run_id: interactionRunId, execution_run_id: executionRunId, request_id: input.requestId ?? "unknown", profile: "property", plan: "search" },
        sessionId: actor.sessionId,
      });
      // The tool wrapper receives model arguments, while the bound port executes
      // only the grounded filters. Make the user-facing DTO report exactly the
      // filters that reached the canonical Hostmate service.
      if (output && sanitizedToolInput) output = { ...output, appliedFilters: sanitizedToolInput };
      if (!output) throw new OpenRouterRuntimeError("Model did not execute the scoped property search tool", "INVALID_TOOL_CALL", false);
      let result: ExecutionResult<PropertySearchPropertiesOutput | PropertyGetPropertyOutput> = toPropertySearchExecutionResult(output);
      let selectedSearchRef: EntityRef | undefined;
      const outputCandidates = propertyCandidatesFromOutput(output);
      const identificationResolution = isPropertyIdentificationIntent(message) && outputCandidates.length
        ? resolvePropertyMention({ message, messages: priorMessages, selected: currentProperty, candidates: outputCandidates })
        : undefined;
      const deterministicOrderedDetail = needsDetailAfterSearch && isDeterministicOrderedDetail(message, output);
      if ((identificationResolution?.kind === "ambiguous" && !deterministicOrderedDetail) || (!identificationResolution && needsDetailAfterSearch && outputCandidates.length > 1 && !deterministicOrderedDetail)) {
        const ambiguousCandidates = identificationResolution?.kind === "ambiguous" ? identificationResolution.candidates : outputCandidates;
        const question = identificationResolution?.kind === "ambiguous" ? identificationResolution.question : propertyAmbiguityQuestion(ambiguousCandidates);
        result = {
          status: "needs_input", summary: question, entities: ambiguousCandidates.map((candidate) => candidate.ref), data: output,
          blocks: [propertyCandidatesBlock(ambiguousCandidates)],
          errors: [{ code: "AMBIGUOUS", message: "Several property candidates remain after canonical search.", retryable: false }],
          suggestedNext: [question],
        };
        await event("property.search.ambiguous", { candidateRefs: ambiguousCandidates.map((candidate) => candidate.ref), inferenceCount: 1 });
      } else {
        selectedSearchRef = identificationResolution?.kind === "resolved"
          ? identificationResolution.ref
          : output.total === 1 && output.matches.length === 1
            ? output.matches[0]!.ref
            : isDeterministicOrderedDetail(message, output) ? output.matches[0]?.ref : undefined;
        if (selectedSearchRef) context = { selected: { ...context.selected, property: selectedSearchRef }, referenced: context.referenced };
      }
      await this.repository.recordUsage(actor, {
        usageId: randomUUID(), runId: executionRunId, attemptId,
        requestedModel: runtime.requestedModel, resolvedModel: runtime.resolvedModel, provider: runtime.provider,
        inputTokens: runtime.detailedUsage.inputTokens, outputTokens: runtime.detailedUsage.outputTokens,
        reasoningTokens: runtime.detailedUsage.reasoningTokens, cachedTokens: runtime.detailedUsage.cachedTokens,
        costUsd: runtime.detailedUsage.costUsd, latencyMs: runtime.latencyMs,
        fallbackUsed: runtime.detailedUsage.fallbackUsed, finishReason: runtime.finishReason, createdAt: Date.now(),
      });
      await event("model.completed", { inference: 1, requestedModel: runtime.requestedModel, resolvedModel: runtime.resolvedModel, provider: runtime.provider, finishReason: runtime.finishReason, usage: runtime.detailedUsage, latencyMs: runtime.latencyMs });
      if (result.status !== "needs_input" && needsDetailAfterSearch && selectedSearchRef) {
        const selected = output.matches.find((match) => match.ref.id === selectedSearchRef.id);
        if (!selected) throw new OpenRouterRuntimeError("Resolved property candidate is absent from the canonical result", "STALE_REFERENCE", false);
        const detailRuntimeTool = runtimeTools.find((tool) => tool.namespace === "property" && tool.name === "get_property");
        if (!detailRuntimeTool) throw new Error("PERMISSION_DENIED: property detail tool unavailable");
        const detailInput: PropertyGetPropertyInput = { property: selected.ref };
        await event("tool.requested", { toolId: PROPERTY_GET_PROPERTY_TOOL_ID, version: 1, inputRef: selected.ref, provenance: "property.search_properties.v1:first_ordered_result" });
        await event("tool.started", { toolName: "property.get_property", inputSanitized: detailInput });
        const detailToolResult = await detailRuntimeTool.handle(detailInput);
        if (!detailToolResult.success || !detailOutput) throw new Error("Property detail tool failed after search");
        await event("tool.completed", {
          toolName: "property.get_property", service: detailOutput.telemetry.services,
          inputSanitized: detailInput, provenance: "property.search_properties.v1:first_ordered_result",
          latencyMs: detailOutput.telemetry.latencyMs, entityRefs: [detailOutput.ref], resultSanitized: sanitizedDetailEvent(detailOutput),
        });
        context = { selected: { ...context.selected, property: detailOutput.ref }, referenced: context.referenced };
        result = toPropertyGetExecutionResult(detailOutput);
      }
      await this.repository.updateAttempt(actor, { attemptId, expectedStatus: "running", patch: { status: "succeeded", completedAt: Date.now() } });
      await this.repository.updateRun(actor, executionRunId, { status: "completed", resolvedModel: runtime.resolvedModel, provider: runtime.provider, finishReason: runtime.finishReason, resultSummary: result.summary, completedAt: Date.now() }, "running");
      await event("execution.completed", {
        status: result.status, entityCount: result.entities.length, inferenceCount: 1,
        propertyServiceLatencyMs: output.telemetry?.latencyMs,
        detailServiceLatencyMs: detailOutput?.telemetry.latencyMs,
        returned: output.returned, total: output.total, hasMore: output.hasMore,
      });
      await this.persistAssistant(actor, input.conversationId, sequence, executionRunId, result, context);
      return { conversationId: input.conversationId, interactionRunId, executionRunId, result, runtime };
    } catch (error) {
      const runtimeError = error instanceof OpenRouterRuntimeError ? error : undefined;
      const code = runtimeError?.code ?? (/PERMISSION|STALE_REFERENCE/.test(String(error)) ? "PERMISSION_DENIED" : "INTERNAL");
      const result: ExecutionResult<PropertySearchPropertiesOutput | PropertyGetPropertyOutput> = {
        status: code === "PERMISSION_DENIED" ? "permission_denied" : "failed",
        summary: code === "PERMISSION_DENIED" ? "La búsqueda no está disponible dentro de tu scope actual." : "No se pudo completar la búsqueda de inmuebles.",
        entities: [], errors: [{ code, message: runtimeError?.message ?? "Internal execution error", retryable: runtimeError?.retryable ?? false }],
      };
      await this.repository.updateAttempt(actor, { attemptId, expectedStatus: "running", patch: { status: code === "TIMEOUT" ? "timeout" : "failed", completedAt: Date.now(), errorCode: code } });
      await this.repository.updateRun(actor, executionRunId, { status: code === "TIMEOUT" ? "timeout" : "failed", errorCode: code, resultSummary: result.summary, completedAt: Date.now() }, "running");
      await event("execution.failed", { errorCode: code, retryable: result.errors[0]?.retryable ?? false });
      await this.persistAssistant(actor, input.conversationId, sequence, executionRunId, result, context);
      return { conversationId: input.conversationId, interactionRunId, executionRunId, result };
    }
  }

  private async executeDirectDetail(input: {
    actor: ActorContext;
    input: { conversationId: string; requestId?: string };
    message: string;
    interactionRunId: string;
    executionRunId: string;
    attemptId: string;
    sequence: number;
    context: ConversationContextRefs;
    detailRef: EntityRef;
    event: (type: string, payload: unknown, linkage?: "current" | "interaction" | "execution") => Promise<void>;
  }): Promise<PropertySearchTurnResult> {
    const { actor, message, interactionRunId, executionRunId, attemptId, sequence, detailRef, event } = input;
    let context = input.context;
    let detailOutput: PropertyGetPropertyOutput | undefined;
    const detailTool = createPropertyGetPropertyTool({ port: this.propertyDetail, onResult: (result) => { detailOutput = result; } });
    const registry = new ProductToolRegistry([detailTool]);
    const dispatch = new ExecutionDispatchResolver(new ExecutionProfileRegistry(), registry, new SkillRegistry()).resolve({
      actor, allowedToolIds: [PROPERTY_GET_PROPERTY_TOOL_ID], featureEnabled: (toolId) => toolId === PROPERTY_GET_PROPERTY_TOOL_ID,
      request: {
        profileId: "property", objective: message, objectiveClasses: ["property.lookup"], objectiveCapabilities: ["property.property.read"],
        inputRefs: [detailRef], dependencyRunIds: [], internalSkillHints: [], constraints: { readOnly: true, maxResults: 1 },
      },
    });
    const toolScope = dispatch.toolResolution.tools.map((tool) => `${tool.toolId}@${tool.version}`);
    // The direct path allocates IDs before entering this method. Keep the
    // dispatch event interaction-only until the Execution Run and Attempt
    // documents exist, otherwise Convex correctly rejects dangling links.
    await event("interaction.dispatch.resolved", { profile: "property", profileVersion: dispatch.profile.version, toolScope, skillVersions: {}, inputRefs: [detailRef] }, "interaction");
    await this.repository.updateRun(actor, interactionRunId, { status: "completed", resultSummary: "Dispatched property detail", completedAt: Date.now() }, "running");

    await this.repository.createRun(actor, {
      runId: executionRunId, conversationId: input.input.conversationId, kind: "execution", profileId: "property", profileVersion: dispatch.profile.version,
      objectiveHash: dispatch.objectiveHash, objectiveRedacted: message.slice(0, 240), parentRunId: interactionRunId,
      dependencyRunIds: [], registryHash: dispatch.toolResolution.registryHash, skillVersions: {}, toolScope, visibility: "user",
    });
    if (dispatch.toolResolution.tools.length !== 1) {
      const result: ExecutionResult<PropertySearchPropertiesOutput | PropertyGetPropertyOutput> = {
        status: "permission_denied", summary: "No tienes permiso para consultar el detalle de este inmueble.", entities: [],
        errors: [{ code: "PERMISSION_DENIED", message: dispatch.toolResolution.rejected[0]?.reason ?? "Tool unavailable", retryable: false }],
      };
      await this.repository.updateRun(actor, executionRunId, { status: "failed", errorCode: "PERMISSION_DENIED", resultSummary: result.summary, completedAt: Date.now() }, "queued");
      await event("execution.permission_denied", { rejected: dispatch.toolResolution.rejected, inferenceCount: 0 }, "execution");
      await this.persistAssistant(actor, input.input.conversationId, sequence, executionRunId, result, context);
      return { conversationId: input.input.conversationId, interactionRunId, executionRunId, result };
    }

    await this.repository.createAttempt(actor, { attemptId, runId: executionRunId, attemptNumber: 1, status: "queued", fencingToken: 0 });
    await this.repository.updateAttempt(actor, { attemptId, expectedStatus: "queued", patch: { status: "running", startedAt: Date.now() } });
    await this.repository.updateRun(actor, executionRunId, { status: "running" }, "queued");
    await event("execution.started", { profile: "property", profileVersion: dispatch.profile.version, inferenceCount: 0 });
    try {
      const runtimeTool = registry.compileRuntimeTools({
        resolved: dispatch.toolResolution, actor, policy: new DefaultPolicyEngine(), profileId: "property",
        decisionId: () => randomUUID(), hasRequiredPreconditions: () => true,
      })[0]!;
      const sanitizedInput: PropertyGetPropertyInput = { property: detailRef as PropertyGetPropertyInput["property"] };
      await event("tool.requested", { toolId: PROPERTY_GET_PROPERTY_TOOL_ID, version: 1, inputRef: detailRef, provenance: "authorized_conversation_selection" });
      await event("tool.started", { toolName: "property.get_property", inputSanitized: sanitizedInput });
      const toolResult = await runtimeTool.handle(sanitizedInput);
      if (!toolResult.success || !detailOutput) throw new Error("Property detail tool failed");
      await event("tool.completed", {
        toolName: "property.get_property", service: detailOutput.telemetry.services,
        inputSanitized: sanitizedInput, provenance: "authorized_conversation_selection",
        latencyMs: detailOutput.telemetry.latencyMs, entityRefs: [detailOutput.ref], resultSanitized: sanitizedDetailEvent(detailOutput),
      });
      const result = toPropertyGetExecutionResult(detailOutput);
      context = { selected: { ...context.selected, property: detailOutput.ref }, referenced: context.referenced };
      await this.repository.updateAttempt(actor, { attemptId, expectedStatus: "running", patch: { status: "succeeded", completedAt: Date.now() } });
      await this.repository.updateRun(actor, executionRunId, { status: "completed", resultSummary: result.summary, completedAt: Date.now() }, "running");
      await event("execution.completed", { status: result.status, entityCount: 1, inferenceCount: 0, detailServiceLatencyMs: detailOutput.telemetry.latencyMs });
      await this.persistAssistant(actor, input.input.conversationId, sequence, executionRunId, result, context);
      return { conversationId: input.input.conversationId, interactionRunId, executionRunId, result };
    } catch (error) {
      const raw = String(error);
      const denied = /PERMISSION|STALE_REFERENCE|403/.test(raw);
      const notFound = /NOT_FOUND|404/.test(raw);
      const code = denied ? "PERMISSION_DENIED" : notFound ? "NOT_FOUND" : "INTERNAL";
      const result: ExecutionResult<PropertySearchPropertiesOutput | PropertyGetPropertyOutput> = {
        status: denied ? "permission_denied" : "failed",
        summary: denied ? "Este inmueble ya no está disponible dentro de tu scope actual." : "No se pudo consultar el detalle del inmueble.",
        entities: [], errors: [{ code, message: "Property detail read failed", retryable: false }],
      };
      await this.repository.updateAttempt(actor, { attemptId, expectedStatus: "running", patch: { status: "failed", completedAt: Date.now(), errorCode: code } });
      await this.repository.updateRun(actor, executionRunId, { status: "failed", errorCode: code, resultSummary: result.summary, completedAt: Date.now() }, "running");
      await event("execution.failed", { errorCode: code, inferenceCount: 0, inputRef: detailRef });
      await this.persistAssistant(actor, input.input.conversationId, sequence, executionRunId, result, context);
      return { conversationId: input.input.conversationId, interactionRunId, executionRunId, result };
    }
  }

  private async persistAssistant(actor: ActorContext, conversationId: string, sequence: number, runId: string | undefined, result: ExecutionResult<PropertySearchPropertiesOutput | PropertyGetPropertyOutput>, context: ConversationContextRefs) {
    const blockRefs = (result.blocks ?? []).flatMap((block) => {
      if (block.type === "entity_list") return block.items.map((item) => item.ref);
      if (block.type === "entity_detail") return [block.ref];
      return [];
    });
    const referenced = [...new Map([...result.entities, ...blockRefs, ...context.referenced].map((ref) => [`${ref.type}:${ref.id}`, ref])).values()].slice(0, 24);
    await this.repository.appendMessage(actor, {
      messageId: randomUUID(), conversationId, role: "assistant", contentRedacted: result.summary,
      blocks: result.blocks, contextRefs: { selected: context.selected, referenced }, runId, sequence, createdAt: Date.now(),
    });
  }
}
