import { OpenRouterAdapter } from "../server/hostmate/runtime/openrouter-adapter.js";
import {
  HOSTMATE_GENERATIVE_FALLBACK_MODELS,
  HOSTMATE_GENERATIVE_MODEL,
  HOSTMATE_GENERATIVE_REASONING_EFFORT,
} from "../server/hostmate/runtime/model-policy.js";
import { buildCanonicalConversationEvidence } from "../server/hostmate/shadow/canonical-conversation-evidence.js";
import { runBoopInteractionShadow } from "../server/hostmate/shadow/boop-interaction-shadow.js";
import type { EntityRef } from "../server/hostmate/contracts/domain.js";
import type { AgentContentBlock } from "../server/hostmate/contracts/execution-result.js";
import type { AgentMessageRecord, ConversationContextRefs } from "../server/hostmate/control-plane/repository.js";
import {
  resolveTenantPropertyCandidate,
  type TenantPropertyCandidate,
} from "../server/hostmate/interaction/property-candidate-grounding.js";

const apiKey = process.env.OPENROUTER_API_KEY?.trim();
if (!apiKey) throw new Error("OPENROUTER_API_KEY is required");

const actor = { tenantId: "validation-tenant", userId: "validation-user" };
const properties = {
  a: { type: "property.property", id: "101", label: "Bonavista 3 habitaciones" },
  b: { type: "property.property", id: "102", label: "Bonavista 4 habitaciones" },
  c: { type: "property.property", id: "103", label: "Manresa con terraza" },
  urgellSale: { type: "property.property", id: "104", label: "Piso en Calle del Comte d'Urgell" },
  urgellRent: { type: "property.property", id: "105", label: "Piso en Calle del Comte d'Urgell" },
} as const satisfies Record<string, EntityRef>;
const leads = {
  a: { type: "crm.lead", id: "201", label: "Laura Soler" },
  b: { type: "crm.lead", id: "202", label: "Roger Closas" },
} as const satisfies Record<string, EntityRef>;

function context(selected: ConversationContextRefs["selected"], referenced: readonly EntityRef[]): ConversationContextRefs {
  return { selected, referenced };
}

function message(input: Readonly<{
  conversationId: string;
  sequence: number;
  role: "user" | "assistant";
  content: string;
  blocks?: readonly AgentContentBlock[];
  contextRefs?: ConversationContextRefs;
}>): AgentMessageRecord {
  return {
    messageId: `${input.conversationId}:${input.sequence}`,
    conversationId: input.conversationId,
    tenantId: actor.tenantId,
    actorUserId: actor.userId,
    role: input.role,
    contentRedacted: input.content,
    blocks: input.blocks,
    contextRefs: input.contextRefs,
    sequence: input.sequence,
    createdAt: 1_700_000_000_000 + input.sequence,
  };
}

function propertyList(...refs: readonly EntityRef[]): AgentContentBlock {
  return {
    type: "entity_list",
    title: "Inmuebles encontrados",
    items: refs.map((ref, index) => ({
      ref,
      title: ref.label ?? `Inmueble ${index + 1}`,
      subtitle: index < 2 ? "Barcelona · Bonavista" : "Manresa",
      fields: [
        { label: "Habitaciones", value: String(index === 0 ? 3 : index === 1 ? 4 : 3) },
        { label: "Precio", value: index === 0 ? "450.000 €" : index === 1 ? "520.000 €" : "390.000 €" },
        ...(index === 2 ? [{ label: "Características", value: "terraza" }] : []),
      ],
    })),
  };
}

function entityDetail(ref: EntityRef): AgentContentBlock {
  return {
    type: "entity_detail",
    title: ref.label ?? "Inmueble",
    ref,
    sections: [{ title: "Datos", fields: [{ label: "Referencia", value: ref.id }] }],
  };
}

function duplicateAddressPropertyList(): AgentContentBlock {
  return {
    type: "entity_list",
    title: "Inmuebles encontrados",
    items: [
      { ref: properties.urgellSale, title: properties.urgellSale.label!, subtitle: "00951 · Barcelona", fields: [{ label: "Precio", value: "585.000 €" }, { label: "Operación", value: "comprar" }, { label: "Superficie", value: "81 m²" }] },
      { ref: properties.urgellRent, title: properties.urgellRent.label!, subtitle: "00950 · Barcelona", fields: [{ label: "Precio", value: "2.800 €" }, { label: "Operación", value: "alquilar" }, { label: "Superficie", value: "115 m²" }] },
    ],
  };
}

function listHistory(conversationId: string, refs: readonly EntityRef[]): readonly AgentMessageRecord[] {
  return [
    message({ conversationId, sequence: 1, role: "user", content: "Busca inmuebles" }),
    message({
      conversationId, sequence: 2, role: "assistant", content: `He encontrado ${refs.length} inmuebles.`,
      blocks: [propertyList(...refs)], contextRefs: context({}, refs),
    }),
  ];
}

function focusHistory(conversationId: string, refs: readonly EntityRef[]): readonly AgentMessageRecord[] {
  return refs.flatMap((ref, index) => [
    message({ conversationId, sequence: index * 2 + 1, role: "user", content: index ? "Muéstrame el siguiente" : "Muéstrame este" }),
    message({
      conversationId, sequence: index * 2 + 2, role: "assistant", content: `Detalle de ${ref.label}.`,
      blocks: [entityDetail(ref)], contextRefs: context({ property: ref }, refs.slice(0, index + 1)),
    }),
  ]);
}

type Scenario = Readonly<{
  name: string;
  currentMessage: string;
  messages?: readonly AgentMessageRecord[];
  expectedAction: string;
  expectedPropertyId?: string;
  expectedClarification?: boolean;
  expectedTargetQuery?: string;
  expectedTargetNull?: boolean;
}>;

const scenarios: readonly Scenario[] = [
  { name: "discovery-city-feature", currentMessage: "Busca pisos con terraza en Barcelona", expectedAction: "property.search_properties.v1", expectedTargetNull: true },
  { name: "identify-title", currentMessage: "¿Cuánto cuesta el piso de Bonavista?", expectedAction: "property.search_properties.v1", expectedTargetQuery: "bonavista" },
  { name: "identify-address", currentMessage: "Enséñame el inmueble de calle de Loreto", expectedAction: "property.search_properties.v1", expectedTargetQuery: "loreto" },
  { name: "ordinal-without-list", currentMessage: "Enséñame el segundo inmueble", expectedAction: "needs_clarification", expectedClarification: true },
  { name: "ordinal-second", currentMessage: "¿Cuánto vale el segundo?", messages: listHistory("ordinal-second", [properties.a, properties.b, properties.c]), expectedAction: "property.get_property.v1", expectedPropertyId: "102" },
  { name: "ordinal-first", currentMessage: "Ahora enséñame el primero", messages: listHistory("ordinal-first", [properties.a, properties.b, properties.c]), expectedAction: "property.get_property.v1", expectedPropertyId: "101" },
  { name: "descriptive-known", currentMessage: "El de Bonavista de cuatro habitaciones", messages: listHistory("descriptive-known", [properties.a, properties.b, properties.c]), expectedAction: "property.get_property.v1", expectedPropertyId: "102" },
  { name: "this-last-card", currentMessage: "¿Cuánto cuesta este piso?", messages: focusHistory("this-last-card", [properties.a, properties.b]), expectedAction: "property.get_property.v1", expectedPropertyId: "102" },
  { name: "previous-card", currentMessage: "No, me refería al inmueble anterior", messages: focusHistory("previous-card", [properties.a, properties.b]), expectedAction: "property.get_property.v1", expectedPropertyId: "101" },
  { name: "other-of-two", currentMessage: "No, el otro piso", messages: focusHistory("other-of-two", [properties.a, properties.b]), expectedAction: "property.get_property.v1", expectedPropertyId: "101" },
  { name: "other-of-three", currentMessage: "No, el otro piso", messages: focusHistory("other-of-three", [properties.a, properties.b, properties.c]), expectedAction: "needs_clarification", expectedClarification: true },
  {
    name: "property-domain-wins", currentMessage: "Enséñame ese piso",
    messages: [
      ...focusHistory("property-domain-wins", [properties.a]),
      message({ conversationId: "property-domain-wins", sequence: 3, role: "assistant", content: "También vimos a Laura.", contextRefs: context({ property: properties.a, lead: leads.a }, [properties.a, leads.a]) }),
    ],
    expectedAction: "property.get_property.v1", expectedPropertyId: "101",
  },
  {
    name: "visit-domain-newest-lead-list", currentMessage: "Consulta las visitas del primero",
    messages: [
      ...focusHistory("visit-domain-newest-lead-list", [properties.a]),
      message({
        conversationId: "visit-domain-newest-lead-list", sequence: 3, role: "assistant", content: "Dos leads.",
        blocks: [{ type: "entity_list", title: "Leads", items: [leads.a, leads.b].map((ref) => ({ ref, title: ref.label!, fields: [] })) }],
        contextRefs: context({ property: properties.a }, [properties.a, leads.a, leads.b]),
      }),
    ],
    expectedAction: "visits.search_visits.v1",
  },
  {
    name: "explicit-no-result", currentMessage: "¿Y ese piso?",
    messages: [
      ...focusHistory("explicit-no-result", [properties.a]),
      message({ conversationId: "explicit-no-result", sequence: 3, role: "user", content: "Busca el de Girona" }),
      message({ conversationId: "explicit-no-result", sequence: 4, role: "assistant", content: "No he encontrado ningún inmueble en Girona.", contextRefs: context({ property: properties.a }, [properties.a]) }),
    ],
    expectedAction: "needs_clarification", expectedClarification: true,
  },
  {
    name: "create-with-known-targets", currentMessage: "Agenda una visita mañana a las 10:00",
    messages: [
      message({ conversationId: "create-with-known-targets", sequence: 1, role: "assistant", content: "Lead e inmueble seleccionados.", contextRefs: context({ lead: leads.b, property: properties.a }, [leads.b, properties.a]) }),
    ],
    expectedAction: "visits.create_visit.v1", expectedPropertyId: "101",
  },
  { name: "create-with-named-targets", currentMessage: "Agenda una visita mañana a las 10:00 para el piso en calle de Loreto con Roger Closas", expectedAction: "visits.create_visit.v1", expectedTargetNull: true },
  { name: "create-missing-time", currentMessage: "Agenda una visita mañana por la tarde para el piso de Bonavista con Roger Closas", expectedAction: "needs_clarification", expectedClarification: true },
  { name: "discovery-descriptive", currentMessage: "Busca pisos reformados con terraza en Barcelona", expectedAction: "property.search_properties.v1", expectedTargetNull: true },
  {
    name: "known-duplicate-address-ambiguous",
    currentMessage: "¿Cuánto cuesta el piso del Comte d'Urgell?",
    messages: [
      message({ conversationId: "known-duplicate-address-ambiguous", sequence: 1, role: "user", content: "Busca pisos en Barcelona con terraza" }),
      message({
        conversationId: "known-duplicate-address-ambiguous", sequence: 2, role: "assistant", content: "He encontrado dos inmuebles en Comte d'Urgell.",
        blocks: [duplicateAddressPropertyList()],
        contextRefs: context({}, [properties.urgellSale, properties.urgellRent]),
      }),
    ],
    expectedAction: "needs_clarification",
    expectedClarification: true,
  },
];

const adapter = new OpenRouterAdapter({
  apiKey,
  appName: "Hostmate Property Grounding Conversation Validation",
  maxTransportRetries: 2,
});

const results = [];
for (const [index, scenario] of scenarios.entries()) {
  const conversationId = scenario.name;
  const messages = scenario.messages ?? [];
  const evidence = buildCanonicalConversationEvidence({ actor, conversationId, messages, historyWindow: 10, resultWindow: 10 });
  const outcome = await runBoopInteractionShadow({
    conversationId,
    turn: messages.filter((item) => item.role === "user").length + 1,
    currentMessage: scenario.currentMessage,
    history: evidence.conversationHistory,
    evidence,
  }, {
    apiKey,
    adapter,
    model: HOSTMATE_GENERATIVE_MODEL,
    reasoningEffort: HOSTMATE_GENERATIVE_REASONING_EFFORT,
    fallbackModels: HOSTMATE_GENERATIVE_FALLBACK_MODELS,
    timeoutMs: 120_000,
    maxCostUsd: 0.05,
    temperature: 0,
  });
  const proposal = outcome.proposal;
  const propertyKey = proposal?.candidateRefs.find((candidate) => candidate.type === "property.property")?.evidenceKey;
  const resolvedPropertyId = propertyKey ? evidence.entityIndex[propertyKey]?.ref.id : undefined;
  const targetQuery = proposal?.propertyTargetSearch?.query?.toLocaleLowerCase("es-ES") ?? null;
  const checks = {
    validProposal: outcome.proposalStatus === "captured" && Boolean(proposal),
    action: proposal?.action === scenario.expectedAction,
    property: scenario.expectedPropertyId === undefined || resolvedPropertyId === scenario.expectedPropertyId,
    clarification: scenario.expectedClarification === undefined || proposal?.needsClarification === scenario.expectedClarification,
    targetQuery: scenario.expectedTargetQuery === undefined || Boolean(targetQuery?.includes(scenario.expectedTargetQuery)),
    targetNull: scenario.expectedTargetNull === undefined || proposal?.propertyTargetSearch === null,
    candidateKeys: outcome.validation.invalidCandidateKeys.length === 0 && outcome.validation.unauthorizedCandidateKeys.length === 0,
  };
  const pass = Object.values(checks).every(Boolean);
  results.push({
    index: index + 1,
    name: scenario.name,
    pass,
    checks,
    expectedAction: scenario.expectedAction,
    action: proposal?.action ?? null,
    resolvedPropertyId: resolvedPropertyId ?? null,
    propertyTargetSearch: proposal?.propertyTargetSearch ?? null,
    needsClarification: proposal?.needsClarification ?? null,
    latencyMs: outcome.latencyMs,
    inputTokens: outcome.detailedUsage?.inputTokens ?? 0,
    outputTokens: outcome.detailedUsage?.outputTokens ?? 0,
    costUsd: outcome.detailedUsage?.costUsd ?? 0,
    error: outcome.error ?? null,
  });
}

const passed = results.filter((result) => result.pass).length;
const groundingCandidates: readonly TenantPropertyCandidate[] = [
  { id: "865", reference: "BONA-3", title: "Bonavista 3 habitaciones", address: "Carrer Bonavista 1", neighborhood: "Gràcia", city: "Barcelona", price: 450000, rooms: 3, bathrooms: 2, areaBuilt: 90, propertySubtype: "piso", character: { has_terrace: true }, descriptionExcerpt: "Reformado" },
  { id: "866", reference: "BONA-4", title: "Bonavista 4 habitaciones", address: "Carrer Bonavista 8", neighborhood: "Gràcia", city: "Barcelona", price: 520000, rooms: 4, bathrooms: 2, areaBuilt: 115, propertySubtype: "piso", character: null, descriptionExcerpt: "Amplio" },
  { id: "867", reference: "MAN-TER", title: "Piso en Manresa con terraza", address: "Carrer Nou 3", neighborhood: "Centre", city: "Manresa", price: 390000, rooms: 3, bathrooms: 2, areaBuilt: 95, propertySubtype: "piso", character: { has_terrace: true }, descriptionExcerpt: "Terraza soleada" },
  { id: "868", reference: "LORETO", title: "Piso en calle de Loreto", address: "Calle de Loreto 10", neighborhood: "Les Corts", city: "Barcelona", price: 400000, rooms: 3, bathrooms: 2, areaBuilt: 90, propertySubtype: "piso", character: null, descriptionExcerpt: null },
  { id: "869", reference: "URGELL-SALE", title: "Piso en Calle del Comte d'Urgell", address: "Calle del Comte d'Urgell", neighborhood: "L'Antiga Esquerra de l'Eixample", city: "Barcelona", price: 585000, rooms: 3, bathrooms: 1, areaBuilt: 81, propertySubtype: "piso", character: null, descriptionExcerpt: null },
  { id: "870", reference: "URGELL-RENT", title: "Piso en Calle del Comte d'Urgell", address: "Calle del Comte d'Urgell", neighborhood: "L'Antiga Esquerra de l'Eixample", city: "Barcelona", price: 2800, rooms: 3, bathrooms: 2, areaBuilt: 115, propertySubtype: "piso", character: null, descriptionExcerpt: null },
];
const groundingScenarios = [
  { name: "candidate-title-address", clue: "calle de Loreto", message: "¿Cuánto cuesta el piso en calle de Loreto?", candidates: [groundingCandidates[3]!], expected: "selected", id: "868" },
  { name: "candidate-ambiguous", clue: "Bonavista", message: "¿Cuánto cuesta el piso de Bonavista?", candidates: groundingCandidates.slice(0, 2), expected: "needs_input" },
  { name: "candidate-combined-signals", clue: "Bonavista de cuatro habitaciones", message: "El de Bonavista de cuatro habitaciones", candidates: groundingCandidates.slice(0, 2), expected: "selected", id: "866" },
  { name: "candidate-price", clue: "Bonavista unos 450.000", message: "El de Bonavista que costaba unos 450.000", candidates: groundingCandidates.slice(0, 2), expected: "selected", id: "865" },
  { name: "candidate-city-feature", clue: "Manresa con terraza", message: "El de Manresa con terraza", candidates: groundingCandidates, expected: "selected", id: "867" },
  { name: "candidate-contradiction", clue: "Girona", message: "El piso de Girona", candidates: [groundingCandidates[3]!], expected: "needs_input" },
  { name: "candidate-same-address-ambiguous", clue: "Comte d'Urgell", message: "¿Cuánto cuesta el piso del Comte d'Urgell?", candidates: groundingCandidates.slice(4, 6), expected: "needs_input" },
] as const;
const groundingEvidence = {
  currentSelection: {}, referencedEntities: [], recentResultEvidence: [], conversationHistory: [], candidateRefs: [],
  orderedContext: { recentResultSets: [], recentFocusedEntities: [] },
};
const groundingResults = [];
for (const scenario of groundingScenarios) {
  const resolution = await resolveTenantPropertyCandidate({
    query: scenario.clue,
    currentMessage: scenario.message,
    evidence: groundingEvidence,
    search: { query: scenario.clue, total: scenario.candidates.length, items: scenario.candidates, latencyMs: 0 },
    runtime: adapter,
    model: HOSTMATE_GENERATIVE_MODEL,
    reasoningEffort: HOSTMATE_GENERATIVE_REASONING_EFFORT,
    fallbackModels: HOSTMATE_GENERATIVE_FALLBACK_MODELS,
    sessionId: "property-grounding-validation",
  });
  const selectedId = resolution.outcome === "selected" ? resolution.candidate.id : null;
  const pass = resolution.outcome === scenario.expected && (!("id" in scenario) || selectedId === scenario.id);
  groundingResults.push({ name: scenario.name, pass, outcome: resolution.outcome, selectedId, costUsd: resolution.costUsd });
}
const groundingPassed = groundingResults.filter((result) => result.pass).length;
const report = {
  model: HOSTMATE_GENERATIVE_MODEL,
  reasoningEffort: HOSTMATE_GENERATIVE_REASONING_EFFORT,
  cases: results.length,
  passed,
  failed: results.length - passed,
  totalCostUsd: results.reduce((total, result) => total + result.costUsd, 0)
    + groundingResults.reduce((total, result) => total + result.costUsd, 0),
  results,
  candidateGrounding: {
    cases: groundingResults.length,
    passed: groundingPassed,
    failed: groundingResults.length - groundingPassed,
    results: groundingResults,
  },
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (passed !== results.length || groundingPassed !== groundingResults.length) process.exitCode = 1;
