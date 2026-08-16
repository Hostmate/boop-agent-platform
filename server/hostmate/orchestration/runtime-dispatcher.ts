import type { ActorContext } from "../contracts/actor-context.js";
import type { AgentMessageRecord, ControlPlaneRepository } from "../control-plane/repository.js";
import type { LeadContextPort } from "../product-tools/crm/get-lead-context.js";
import type { PropertySearchPort } from "../product-tools/property/search-properties.js";
import type { LeadVisitsPort } from "../product-tools/visits/list-lead-visits.js";
import { isLeadOpportunityAnalysisIntent } from "./lead-opportunity-definition.js";
import { LeadOpportunityOrchestrationRunner, multiAgentEnabled, type MultiAgentTurnInput } from "./runner.js";

export type RuntimeOrchestrationConfig = Readonly<{
  enabled: boolean;
  allowedTenantIds: readonly string[];
  allowedUserIds: readonly string[];
}>;

export type RuntimeOrchestrationDependencies = Readonly<{
  repository: ControlPlaneRepository;
  leadContextPort: LeadContextPort;
  leadVisitsPort: LeadVisitsPort;
  propertySearchPort: PropertySearchPort;
}>;

export function classifyOrchestrationIntent(message: string): "lead-opportunity-analysis" | undefined {
  return isLeadOpportunityAnalysisIntent(message) ? "lead-opportunity-analysis" : undefined;
}

export function createRuntimeOrchestrationExecutor(
  intent: "lead-opportunity-analysis",
  actor: ActorContext,
  config: RuntimeOrchestrationConfig | undefined,
  dependencies: RuntimeOrchestrationDependencies,
) {
  switch (intent) {
    case "lead-opportunity-analysis":
      return new LeadOpportunityOrchestrationRunner(dependencies, multiAgentEnabled(actor, config));
  }
}

export type RuntimeOrchestrationInput = MultiAgentTurnInput & Readonly<{ priorMessages: readonly AgentMessageRecord[] }>;
