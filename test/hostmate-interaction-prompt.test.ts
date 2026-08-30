import { describe, expect, it } from "vitest";
import {
  HOSTMATE_INTERACTION_CAPABILITIES,
  HOSTMATE_INTERACTION_ORCHESTRATION_TARGETS,
  HOSTMATE_INTERACTION_PROMPT_VERSION,
  HOSTMATE_INTERACTION_SYSTEM,
} from "../server/hostmate/shadow/hostmate-interaction-prompt.js";

describe("Hostmate Interaction Pareto prompt", () => {
  it("contains the frozen capability surface and the authority boundary", () => {
    expect(HOSTMATE_INTERACTION_PROMPT_VERSION).toBe(10);
    expect(HOSTMATE_INTERACTION_CAPABILITIES).toHaveLength(15);
    expect(HOSTMATE_INTERACTION_ORCHESTRATION_TARGETS).toEqual(["multi-agent.lead-opportunity-analysis.v1"]);
    for (const capability of HOSTMATE_INTERACTION_CAPABILITIES) expect(HOSTMATE_INTERACTION_SYSTEM).toContain(capability);
    expect(HOSTMATE_INTERACTION_SYSTEM).toContain("semantic planner, not an executor");
    expect(HOSTMATE_INTERACTION_SYSTEM).toContain("never authority");
    expect(HOSTMATE_INTERACTION_SYSTEM).toContain("human-confirmed Draft");
    expect(HOSTMATE_INTERACTION_SYSTEM).toContain("A Spanish message must receive Spanish text");
    expect(HOSTMATE_INTERACTION_SYSTEM).toContain("visits.search_visits.v1 reads visits by period");
    expect(HOSTMATE_INTERACTION_SYSTEM).toContain("Never invent relations");
    expect(HOSTMATE_INTERACTION_SYSTEM).toContain("There is currently no capability to list, search or read pending tasks");
    expect(HOSTMATE_INTERACTION_SYSTEM).toContain("A newer result list of the required entity type outranks an older selection from another domain");
    expect(HOSTMATE_INTERACTION_SYSTEM).toContain('"¿Qué tareas pendientes tengo?" is a task read');
    expect(HOSTMATE_INTERACTION_SYSTEM).toContain('"Prepárame la segunda visita" means skill.prepare-visit-brief.v1');
    expect(HOSTMATE_INTERACTION_SYSTEM).toContain('"Prepárame este lead antes de llamarlo" means skill.prepare-lead-brief.v1');
    expect(HOSTMATE_INTERACTION_SYSTEM).toContain("named natural person is the Lead/client");
    expect(HOSTMATE_INTERACTION_SYSTEM).toContain("single targetSearch block");
    expect(HOSTMATE_INTERACTION_SYSTEM).not.toContain("visitTargetSearch");
    expect(HOSTMATE_INTERACTION_SYSTEM).not.toContain("propertyTargetSearch");
  });

  it("removes unrelated personal-Boop integrations and stays compact", () => {
    expect(HOSTMATE_INTERACTION_SYSTEM).not.toContain("iMessage");
    expect(HOSTMATE_INTERACTION_SYSTEM).not.toContain("Apple");
    expect(HOSTMATE_INTERACTION_SYSTEM).not.toContain("Composio");
    expect(HOSTMATE_INTERACTION_SYSTEM).not.toContain("local browser");
    expect(HOSTMATE_INTERACTION_SYSTEM.length).toBeLessThan(5_500);
  });
});
