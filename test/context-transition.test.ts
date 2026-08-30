import { describe, expect, it } from "vitest";
import type { EntityRef } from "../server/hostmate/contracts/domain.js";
import type { ConversationContextRefs } from "../server/hostmate/control-plane/repository.js";
import { applyContextTransition, type ContextRelationFacts, type ContextRole } from "../server/hostmate/interaction/context-transition.js";

const leadA: EntityRef = { type: "crm.lead", id: "101", label: "Lead A" };
const leadB: EntityRef = { type: "crm.lead", id: "102", label: "Lead B" };
const propertyA: EntityRef = { type: "property.property", id: "201", label: "Property A" };
const propertyB: EntityRef = { type: "property.property", id: "202", label: "Property B" };
const visitA: EntityRef = { type: "visits.visit", id: "301", label: "Visit A" };
const visitB: EntityRef = { type: "visits.visit", id: "302", label: "Visit B" };

const roleRefs: Record<ContextRole, readonly [EntityRef, EntityRef]> = {
  lead: [leadA, leadB], property: [propertyA, propertyB], visit: [visitA, visitB],
};

type TransitionCase = Readonly<{
  id: string;
  semantic: "same" | "correction" | "previous" | "other" | "ordinal";
  from: ContextRole;
  to: ContextRole;
  context: ConversationContextRefs;
  selected: EntityRef;
  relations?: ContextRelationFacts;
  expected: Readonly<{ selected: Readonly<Record<ContextRole, EntityRef>> }>;
}>;

function initialContext(): ConversationContextRefs {
  return { selected: { lead: leadA, property: propertyA, visit: visitA }, referenced: [leadA, propertyA, visitA] };
}

function expectedSelection(to: ContextRole, mode: "same" | "different" | "related"): Record<ContextRole, EntityRef> {
  if (mode === "same") return { lead: leadA, property: propertyA, visit: visitA };
  if (mode === "related") {
    if (to === "lead") return { lead: leadB, property: propertyB, visit: visitB };
    if (to === "property") return { lead: leadB, property: propertyB, visit: visitB };
    return { lead: leadA, property: propertyB, visit: visitB };
  }
  if (to === "lead") return { lead: leadB, property: propertyA } as Record<ContextRole, EntityRef>;
  if (to === "property") return { lead: leadA, property: propertyB } as Record<ContextRole, EntityRef>;
  return { visit: visitB } as Record<ContextRole, EntityRef>;
}

function relationFacts(to: ContextRole): ContextRelationFacts {
  if (to === "lead") return { lead: { visit: visitB, property: propertyB } };
  if (to === "property") return { property: { visit: visitB, lead: leadB } };
  return { visit: { lead: leadA, property: propertyB } };
}

function makeCase(index: number, from: ContextRole, to: ContextRole, semantic: TransitionCase["semantic"], mode: "same" | "different" | "related"): TransitionCase {
  const selected = roleRefs[to][mode === "same" ? 0 : 1];
  return {
    id: `context-transition-${String(index).padStart(3, "0")}`,
    semantic, from, to, context: initialContext(), selected,
    ...(mode === "related" ? { relations: relationFacts(to) } : {}),
    expected: { selected: expectedSelection(to, mode) },
  };
}

const matrix: readonly [ContextRole, ContextRole][] = [
  ["lead", "lead"], ["lead", "property"], ["lead", "visit"],
  ["property", "lead"], ["property", "property"], ["property", "visit"],
  ["visit", "lead"], ["visit", "property"], ["visit", "visit"],
];

export const CONTEXT_TRANSITION_CASES: readonly TransitionCase[] = Object.freeze([
  ...matrix.flatMap(([from, to], matrixIndex) => [
    makeCase(matrixIndex * 10 + 1, from, to, "same", "same"),
    makeCase(matrixIndex * 10 + 2, from, to, "correction", "different"),
    makeCase(matrixIndex * 10 + 3, from, to, "previous", "related"),
    makeCase(matrixIndex * 10 + 4, from, to, "other", "different"),
    makeCase(matrixIndex * 10 + 5, from, to, "ordinal", "same"),
    makeCase(matrixIndex * 10 + 6, from, to, "correction", "related"),
    makeCase(matrixIndex * 10 + 7, from, to, "previous", "different"),
    makeCase(matrixIndex * 10 + 8, from, to, "other", "same"),
    makeCase(matrixIndex * 10 + 9, from, to, "ordinal", "related"),
    makeCase(matrixIndex * 10 + 10, from, to, "same", "different"),
  ]),
  ...Array.from({ length: 30 }, (_, index) => {
    const [from, to] = matrix[index % matrix.length]!;
    const semantic = (["previous", "other", "ordinal", "correction"] as const)[index % 4];
    return makeCase(91 + index, from, to, semantic, index % 2 ? "different" : "same");
  }),
]);

function refKey(ref: EntityRef | undefined): string | undefined {
  return ref ? `${ref.type}:${ref.id}` : undefined;
}

describe("canonical context transition matrix", () => {
  it("executes the explicit 120-case transition corpus without incompatible context", () => {
    expect(CONTEXT_TRANSITION_CASES).toHaveLength(120);
    let transitionCorrect = 0;
    let retentionCorrect = 0;
    let retentionTotal = 0;
    let invalidationCorrect = 0;
    let invalidationTotal = 0;
    let incompatible = 0;

    for (const testCase of CONTEXT_TRANSITION_CASES) {
      const actual = applyContextTransition({
        context: testCase.context,
        selected: testCase.selected,
        relations: testCase.relations,
      }).context;
      const expected = testCase.expected.selected;
      const actualKeys = Object.keys(actual.selected).sort();
      const expectedKeys = Object.keys(expected).sort();
      const exact = actualKeys.length === expectedKeys.length
        && expectedKeys.every((role) => refKey(actual.selected[role]) === refKey(expected[role]));
      if (exact) transitionCorrect += 1;
      expect(actual.selected).toEqual(expect.objectContaining(expected));
      expect(actualKeys).toEqual(expectedKeys);

      for (const role of ["lead", "property", "visit"] as const) {
        const before = testCase.context.selected[role];
        const after = actual.selected[role];
        const expectedRetained = Boolean(before && expected[role] && refKey(before) === refKey(expected[role]));
        const actualRetained = Boolean(before && after && refKey(before) === refKey(after));
        retentionTotal += 1;
        if (expectedRetained === actualRetained) retentionCorrect += 1;

        const expectedInvalidated = Boolean(before && !expected[role]);
        const actualInvalidated = Boolean(before && !after);
        invalidationTotal += 1;
        if (expectedInvalidated === actualInvalidated) invalidationCorrect += 1;
      }

      const history = new Set(actual.referenced.map(refKey));
      for (const ref of Object.values(testCase.context.selected)) expect(history.has(refKey(ref))).toBe(true);
      expect(history.has(refKey(testCase.selected))).toBe(true);
      if (testCase.to === "visit" && testCase.relations?.visit) {
        if (testCase.relations.visit.lead && refKey(actual.selected.lead) !== refKey(testCase.relations.visit.lead)) incompatible += 1;
        if (testCase.relations.visit.property && refKey(actual.selected.property) !== refKey(testCase.relations.visit.property)) incompatible += 1;
      }
    }

    expect(transitionCorrect).toBe(CONTEXT_TRANSITION_CASES.length);
    expect(retentionCorrect / retentionTotal).toBe(1);
    expect(invalidationCorrect / invalidationTotal).toBe(1);
    expect(incompatible).toBe(0);
  });
});
