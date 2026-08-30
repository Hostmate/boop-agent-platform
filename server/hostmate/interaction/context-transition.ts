import type { EntityRef } from "../contracts/domain.js";
import type { ConversationContextRefs } from "../control-plane/repository.js";

export type ContextRole = "lead" | "visit" | "property";

export type ContextRelationFacts = Readonly<{
  lead?: Readonly<{ visit?: EntityRef; property?: EntityRef }>;
  visit?: Readonly<{ lead?: EntityRef; property?: EntityRef }>;
  property?: Readonly<{ lead?: EntityRef; visit?: EntityRef }>;
}>;

export type ContextTransitionDecision = Readonly<{
  role: ContextRole;
  action: "retain" | "replace" | "invalidate";
  reason: string;
}>;

export type ContextTransitionResult = Readonly<{
  context: ConversationContextRefs;
  selectedRole?: ContextRole;
  decisions: readonly ContextTransitionDecision[];
}>;

function roleForRef(ref: EntityRef | undefined): ContextRole | undefined {
  if (ref?.type === "crm.lead") return "lead";
  if (ref?.type === "property.property") return "property";
  if (ref?.type === "visits.visit" || ref?.type === "visits.group_visit") return "visit";
  return undefined;
}

function sameRef(left: EntityRef | undefined, right: EntityRef | undefined): boolean {
  return Boolean(left && right && left.type === right.type && left.id === right.id);
}

function validRef(value: unknown): value is EntityRef {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<EntityRef>;
  return typeof candidate.type === "string" && candidate.type.length > 0
    && typeof candidate.id === "string" && candidate.id.length > 0;
}

function uniqueRefs(refs: readonly EntityRef[]): readonly EntityRef[] {
  return [...new Map(refs.filter(validRef).map((ref) => [`${ref.type}:${ref.id}`, ref])).values()];
}

function normalizedSelected(selected: Readonly<Record<string, EntityRef | undefined>>): Record<string, EntityRef> {
  return Object.fromEntries(Object.entries(selected).filter((entry): entry is [string, EntityRef] => validRef(entry[1])));
}

/**
 * Applies one deterministic, authorized context transition. `selected` is a
 * grounding result, never an authorization decision. Relational roles are
 * aligned only from relation facts supplied by a domain read; otherwise the
 * primitive fails closed by invalidating an incompatible relational role.
 */
export function applyContextTransition(input: Readonly<{
  context: ConversationContextRefs;
  selected: EntityRef;
  relations?: ContextRelationFacts;
}>): ContextTransitionResult {
  const selectedRole = roleForRef(input.selected);
  if (!selectedRole) {
    return {
      context: {
        selected: normalizedSelected(input.context.selected),
        referenced: uniqueRefs([...input.context.referenced, ...Object.values(input.context.selected).filter(validRef), input.selected]),
      },
      selectedRole: undefined,
      decisions: [],
    };
  }

  const before = normalizedSelected(input.context.selected);
  const after: Record<string, EntityRef> = { ...before, [selectedRole]: input.selected };
  const decisions: ContextTransitionDecision[] = [
    {
      role: selectedRole,
      action: sameRef(before[selectedRole], input.selected) ? "retain" : "replace",
      reason: sameRef(before[selectedRole], input.selected) ? "same canonical selection" : "new canonical selection",
    },
  ];

  const invalidate = (role: ContextRole, reason: string) => {
    if (!after[role]) return;
    delete after[role];
    decisions.push({ role, action: "invalidate", reason });
  };
  const retain = (role: ContextRole, reason: string) => {
    if (after[role]) decisions.push({ role, action: "retain", reason });
  };
  const replace = (role: ContextRole, ref: EntityRef, reason: string) => {
    const action = sameRef(after[role], ref) ? "retain" : "replace";
    after[role] = ref;
    decisions.push({ role, action, reason });
  };

  if (selectedRole === "property") {
    const facts = input.relations?.property;
    if (facts) {
      if (Object.prototype.hasOwnProperty.call(facts, "lead")) {
        if (facts.lead) replace("lead", facts.lead, "property domain read supplied the lead relation");
        else invalidate("lead", "property domain read confirmed no lead relation");
      }
      if (Object.prototype.hasOwnProperty.call(facts, "visit")) {
        if (facts.visit) replace("visit", facts.visit, "property domain read supplied the visit relation");
        else invalidate("visit", "property domain read confirmed no visit relation");
      }
    } else if (before.visit && !sameRef(before.property, input.selected)) {
      invalidate("visit", "a new property cannot silently retain an unrelated visit");
    } else if (before.visit) {
      retain("visit", "property matches the canonical visit relation");
    }
    if (before.lead) retain("lead", "lead is independently selected and remains valid");
  }

  if (selectedRole === "lead") {
    if (before.visit && !sameRef(before.lead, input.selected)) {
      invalidate("visit", "a new lead cannot silently retain a visit related to another lead");
    } else if (before.visit) {
      retain("visit", "lead matches the canonical visit relation");
    }
    if (before.property) retain("property", "property is independently selected and remains valid");
    const facts = input.relations?.lead;
    if (facts) {
      if (Object.prototype.hasOwnProperty.call(facts, "visit") && facts.visit) replace("visit", facts.visit, "lead domain read supplied the visit relation");
      if (Object.prototype.hasOwnProperty.call(facts, "property") && facts.property) replace("property", facts.property, "lead domain read supplied the property relation");
    }
  }

  if (selectedRole === "visit") {
    const facts = input.relations?.visit;
    if (facts) {
      if (Object.prototype.hasOwnProperty.call(facts, "lead")) {
        if (facts.lead) replace("lead", facts.lead, "visit domain read supplied the lead relation");
        else invalidate("lead", "visit domain read confirmed no lead relation");
      }
      if (Object.prototype.hasOwnProperty.call(facts, "property")) {
        if (facts.property) replace("property", facts.property, "visit domain read supplied the property relation");
        else invalidate("property", "visit domain read confirmed no property relation");
      }
    } else if (!sameRef(before.visit, input.selected)) {
      invalidate("lead", "new visit has no authorized lead relation");
      invalidate("property", "new visit has no authorized property relation");
    } else {
      if (before.lead) retain("lead", "same visit retains its canonical lead context");
      if (before.property) retain("property", "same visit retains its canonical property context");
    }
  }

  const context: ConversationContextRefs = {
    selected: after,
    referenced: uniqueRefs([
      ...input.context.referenced,
      ...Object.values(input.context.selected).filter(validRef),
      input.selected,
      ...Object.values(input.relations?.lead ?? {}).filter(validRef),
      ...Object.values(input.relations?.visit ?? {}).filter(validRef),
      ...Object.values(input.relations?.property ?? {}).filter(validRef),
    ]),
  };
  return { context, selectedRole, decisions };
}
