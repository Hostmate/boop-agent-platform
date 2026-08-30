import { describe, expect, it } from "vitest";
import {
  formatOrderedContextForLlm,
  ORDERED_CONTEXT_INTERPRETATION_GUIDE,
} from "../server/hostmate/shadow/ordered-context-prompt.js";

describe("ordered LLM context presentation", () => {
  it("renders selection, visible positions and card recency without choosing a candidate", () => {
    const rendered = formatOrderedContextForLlm({
      currentSelection: { property: { evidenceKey: "e3", type: "property.property", label: "Bonavista" } },
      orderedContext: {
        recentResultSets: [{
          recency: 1, type: "entity_list", sequence: 8,
          items: [
            { position: 1, evidenceKey: "e1", type: "property.property", label: "Manresa" },
            { position: 2, evidenceKey: "e2", type: "property.property", label: "Barcelona" },
          ],
        }],
        recentFocusedEntities: [
          { recency: 1, evidenceKey: "e3", type: "property.property", label: "Bonavista" },
          { recency: 2, evidenceKey: "e2", type: "property.property", label: "Barcelona" },
        ],
      },
    });

    expect(rendered).toContain("RETAINED ROLE SELECTIONS");
    expect(rendered).toContain("property: e3 | property.property | Bonavista");
    expect(rendered).toContain("1. e1 | property.property | Manresa");
    expect(rendered).toContain("2. e2 | property.property | Barcelona");
    expect(rendered).toContain("ACTIVE FOCUS / LAST SHOWN");
    expect(rendered).toContain("PREVIOUSLY SHOWN");
    expect(rendered).not.toContain("resolvedCandidate");
  });

  it("keeps the guide small and teaches criteria rather than backend decisions", () => {
    expect(ORDERED_CONTEXT_INTERPRETATION_GUIDE).toContain("Interpret the language yourself");
    expect(ORDERED_CONTEXT_INTERPRETATION_GUIDE).toContain("outcome=needs_input");
    expect(ORDERED_CONTEXT_INTERPRETATION_GUIDE).toContain("exactly two relevant entities");
    expect(ORDERED_CONTEXT_INTERPRETATION_GUIDE).toContain('"No, el otro piso" -> clarify');
    expect(ORDERED_CONTEXT_INTERPRETATION_GUIDE).toContain("use position N-1");
    expect(ORDERED_CONTEXT_INTERPRETATION_GUIDE).toContain("never start an unfiltered search");
    expect(ORDERED_CONTEXT_INTERPRETATION_GUIDE).toContain("Evidence keys are opaque labels, not a relevance ranking");
    expect(ORDERED_CONTEXT_INTERPRETATION_GUIDE).toContain("older retained selection from another domain is independent context");
    expect(ORDERED_CONTEXT_INTERPRETATION_GUIDE).toContain("visits.search_visits.v1 with lead e4");
    expect(ORDERED_CONTEXT_INTERPRETATION_GUIDE).toContain("visits.search_visits.v1 with property e4");
    expect(ORDERED_CONTEXT_INTERPRETATION_GUIDE.length).toBeLessThan(2_800);
  });

  it("marks a selection inside a prior list without resolving what the user means", () => {
    const rendered = formatOrderedContextForLlm({
      currentSelection: { property: { evidenceKey: "e2", type: "property.property", label: "Segundo" } },
      orderedContext: {
        recentResultSets: [{
          recency: 1, type: "entity_list", sequence: 1,
          items: [
            { position: 1, evidenceKey: "e1", type: "property.property", label: "Primero" },
            { position: 2, evidenceKey: "e2", type: "property.property", label: "Segundo" },
          ],
        }],
        recentFocusedEntities: [{ recency: 1, evidenceKey: "e2", type: "property.property", label: "Segundo" }],
      },
    });

    expect(rendered).toContain("2. e2 | property.property | Segundo | SELECTED FOR ROLE | ACTIVE FOCUS");
    expect(rendered).not.toContain("resolvedCandidate");
  });
});
