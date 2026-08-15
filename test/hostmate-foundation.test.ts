import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createActorContext } from "../server/hostmate/contracts/actor-context.js";
import { ConvexControlPlaneRepository } from "../server/hostmate/control-plane/convex-control-plane-repository.js";
import { canTransitionDraft, hashDraftArguments } from "../server/hostmate/drafts/contracts.js";
import { redactEventPayload } from "../server/hostmate/events/contracts.js";
import { ExecutionDispatchResolver } from "../server/hostmate/interaction/dispatch.js";
import { canTransitionRun, shouldRetryAttempt } from "../server/hostmate/lifecycle/contracts.js";
import { DefaultPolicyEngine } from "../server/hostmate/policy/engine.js";
import { ExecutionProfileRegistry } from "../server/hostmate/profiles/registry.js";
import { SkillRegistry } from "../server/hostmate/skills/registry.js";
import { ProductToolRegistry } from "../server/hostmate/tools/registry.js";

function actor() {
  return createActorContext({
    tenantId: "tenant-a",
    userId: "user-1",
    role: "agent",
    isSuperAdmin: false,
    permissions: ["crm.read"],
    locale: "es-ES",
    timezone: "Europe/Madrid",
    sessionId: "session-1",
    permissionsVersion: "v1",
  });
}

describe("Hostmate foundation contracts", () => {
  it("creates a frozen, server-authoritative ActorContext", () => {
    const context = actor();
    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(context.permissions)).toBe(true);
    expect(() => createActorContext({ ...context, role: "admin", isSuperAdmin: true })).toThrow("inconsistent");
  });

  it("declares all nine execution profiles without model IDs", () => {
    const profiles = new ExecutionProfileRegistry().list();
    expect(profiles.map((profile) => profile.id)).toEqual([
      "memory", "crm", "demand-matching", "property", "visits", "communications", "marketing", "insights", "workspace-admin",
    ]);
    expect(JSON.stringify(profiles)).not.toMatch(/gpt-|claude-|gemini-/i);
  });

  it("reduces tool scope and closes ActorContext over the handler", async () => {
    const seenTenants: string[] = [];
    const registry = new ProductToolRegistry([
      {
        toolId: "crm.search_leads.v1",
        namespace: "crm",
        name: "search_leads",
        version: 1,
        description: "Search tenant-visible leads",
        ownerDomain: "crm",
        compatibleProfiles: ["crm"],
        capabilities: ["crm.lead.search"],
        mode: "read",
        risk: "R0",
        requiredPermission: "crm.read",
        inputSchema: { query: z.string() },
        outputSchema: z.object({ count: z.number() }),
        availability: "active",
        idempotency: "none",
        handler: async (_input, context) => {
          seenTenants.push(context.tenantId);
          return { count: 1 };
        },
      },
    ]);
    const resolved = registry.resolve({
      profileId: "crm",
      objectiveCapabilities: ["crm.lead.search"],
      actor: actor(),
      featureEnabled: () => true,
      readOnly: true,
    });
    expect(resolved.tools).toHaveLength(1);
    const runtimeTools = registry.compileRuntimeTools({
      resolved,
      actor: actor(),
      policy: new DefaultPolicyEngine(),
      profileId: "crm",
      decisionId: () => "decision-1",
      hasRequiredPreconditions: () => true,
    });
    expect(runtimeTools[0].jsonSchema).not.toHaveProperty("properties.tenantId");
    expect(await runtimeTools[0].handle({ query: "Juan" })).toMatchObject({ success: true });
    expect(seenTenants).toEqual(["tenant-a"]);
  });

  it("never loads a skill by expanding missing tool capabilities", () => {
    const skills = new SkillRegistry();
    expect(skills.resolve({
      profileId: "visits", eligibleSkillIds: ["prepare-visit-brief"],
      objectiveClasses: ["visit.prepare_brief"],
      availableToolCapabilities: [],
      actor: actor(), featureEnabled: () => true,
    })).toEqual([]);
    expect(skills.resolve({
      profileId: "visits", eligibleSkillIds: ["prepare-visit-brief"],
      objectiveClasses: ["visit.prepare_brief"],
      availableToolCapabilities: ["visits.visit.detail", "crm.lead.context", "property.property.read"],
      actor: actor(), featureEnabled: () => true,
    }).map((skill) => skill.id)).toEqual(["prepare-visit-brief"]);
  });

  it("characterizes Interaction-to-Execution dispatch as a reducer-only boundary", () => {
    const toolRegistry = new ProductToolRegistry([{
      toolId: "crm.search_leads.v1", namespace: "crm", name: "search_leads", version: 1,
      description: "search", ownerDomain: "crm", compatibleProfiles: ["crm"], capabilities: ["crm.lead.search"],
      mode: "read", risk: "R0", requiredPermission: "crm.read", inputSchema: { query: z.string() },
      outputSchema: z.object({ count: z.number() }), availability: "active", idempotency: "none",
      handler: async () => ({ count: 0 }),
    }]);
    const resolver = new ExecutionDispatchResolver(new ExecutionProfileRegistry(), toolRegistry, new SkillRegistry());
    const dispatch = resolver.resolve({
      actor: actor(), allowedToolIds: [], featureEnabled: () => true,
      request: {
        profileId: "crm", objective: "Busca a Juan", objectiveClasses: ["lead.lookup"],
        objectiveCapabilities: ["crm.lead.search"], inputRefs: [], dependencyRunIds: [],
        internalSkillHints: ["resolve-ambiguous-lead"], constraints: { readOnly: true },
      },
    });
    expect(dispatch.toolResolution.tools).toEqual([]);
    expect(dispatch.skills).toEqual([]);
    expect(dispatch.objectiveHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("preserves deterministic lifecycle and draft safety invariants", () => {
    expect(canTransitionRun("queued", "running")).toBe(true);
    expect(canTransitionRun("completed", "running")).toBe(false);
    expect(shouldRetryAttempt({ status: "failed", errorCode: "RATE_LIMITED", attemptNumber: 1, maxAttempts: 3, sideEffectOutcome: "none" })).toBe(true);
    expect(shouldRetryAttempt({ status: "failed", errorCode: "TIMEOUT", attemptNumber: 1, maxAttempts: 3, sideEffectOutcome: "unknown" })).toBe(false);
    expect(canTransitionDraft("pending", "approved")).toBe(true);
    expect(canTransitionDraft("committed", "committing")).toBe(false);
    expect(hashDraftArguments({ b: 2, a: 1 })).toBe(hashDraftArguments({ a: 1, b: 2 }));
  });

  it("redacts secrets and PII from durable event payloads", () => {
    expect(redactEventPayload({ apiKey: "secret", phone: "+34123", nested: { value: "ok" } })).toEqual({
      apiKey: "[redacted]",
      phone: "[masked]",
      nested: { value: "ok" },
    });
  });

  it("maps repository calls through the Convex port with actor assertions", async () => {
    const mutation = vi.fn(async (_name: string, args: Record<string, unknown>) => ({ ...args, tenantId: "tenant-a", actorUserId: "user-1", status: "queued", createdAt: 1, updatedAt: 1 }));
    const repository = new ConvexControlPlaneRepository({ mutation, query: vi.fn() });
    await repository.createRun(actor(), {
      runId: "run-1", kind: "execution", profileId: "crm", profileVersion: 1, objectiveHash: "objective",
      dependencyRunIds: [], registryHash: "registry", skillVersions: {}, toolScope: [], visibility: "user",
    });
    expect(mutation).toHaveBeenCalledWith("agentPlatform:createRun", expect.objectContaining({
      expectedTenantId: "tenant-a", expectedUserId: "user-1", runId: "run-1",
    }));
    expect(mutation.mock.calls[0][1]).not.toHaveProperty("tenantId");
  });
});
