import { describe, expect, it, vi } from "vitest";
import { createActorContext } from "../server/hostmate/contracts/actor-context.js";
import {
  createSearchVisitsTool,
  searchVisitsInputSchema,
  toSearchVisitsExecutionResult,
  type VisitSearchPort,
} from "../server/hostmate/product-tools/visits/search-visits.js";
import { formatVisitWallClock, normalizeVisitWallClock } from "../server/hostmate/product-tools/visits/visit-wall-clock.js";

function actor(role: "agent" | "admin" = "admin") {
  return createActorContext({
    tenantId: "9",
    userId: "39",
    role,
    isSuperAdmin: false,
    permissions: ["visits.read"],
    locale: "es-ES",
    timezone: "Europe/Madrid",
    sessionId: "search-visits-test",
    permissionsVersion: "v1",
  });
}

function port(): VisitSearchPort {
  return {
    searchVisits: vi.fn(async (_actor, input) => ({
      visits: [{
        id: "484",
        at: "2099-08-30T17:00:00.000Z",
        status: "confirmed",
        clientName: "Laura Test",
        property: { id: "865", title: "Piso Bonavista", reference: "HM-865" },
        lead: input.lead ? { id: input.lead.id, name: "Laura Test" } : null,
        assignedAgent: { id: "39", name: "Roger" },
        durationMinutes: 60,
        isGroup: false,
      }],
      total: 1,
      returned: 1,
      hasMore: false,
      telemetry: { service: "visit.service.list", latencyMs: 8 },
    })),
  };
}

describe("visits.search_visits.v1", () => {
  it("keeps tenant authority out of the LLM input and accepts authorized relation refs", () => {
    expect(searchVisitsInputSchema.parse({
      timeframe: "today",
      ownership: "tenant",
      lead: { type: "crm.lead", id: "5063" },
    })).toMatchObject({ timeframe: "today", lead: { id: "5063" } });
    expect(searchVisitsInputSchema.safeParse({ timeframe: "today", tenant_id: 9 }).success).toBe(false);
    expect(searchVisitsInputSchema.safeParse({ timeframe: "today", agent_id: 39 }).success).toBe(false);
  });

  it("returns canonical EntityRefs and a UI-neutral complete result block", async () => {
    const visitPort = port();
    const tool = createSearchVisitsTool({ port: visitPort });
    const output = await tool.handler({
      timeframe: "upcoming",
      ownership: "tenant",
      lead: { type: "crm.lead", id: "5063" },
      limit: 50,
    }, actor()) as any;

    expect(visitPort.searchVisits).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: "9" }),
      expect.objectContaining({ lead: expect.objectContaining({ id: "5063" }), limit: 50 }),
    );
    expect(output.visits[0]).toMatchObject({
      ref: { type: "visits.visit", id: "484" },
      at: "2099-08-30T17:00:00",
      property: { ref: { type: "property.property", id: "865" } },
      lead: { ref: { type: "crm.lead", id: "5063" } },
    });
    expect(toSearchVisitsExecutionResult(output)).toMatchObject({
      status: "completed",
      entities: [{ type: "visits.visit", id: "484" }],
      blocks: [{ type: "entity_list" }],
    });
  });

  it("preserves Madrid wall-clock slots across legacy/new transport and DST seasons", () => {
    expect(normalizeVisitWallClock("2026-08-31T19:00:00.000Z")).toBe("2026-08-31T19:00:00");
    expect(normalizeVisitWallClock("2026-01-15T19:00:00")).toBe("2026-01-15T19:00:00");
    expect(normalizeVisitWallClock("2026-03-29T03:30:00")).toBe("2026-03-29T03:30:00");
    expect(normalizeVisitWallClock("2026-10-25T02:30:00.000Z")).toBe("2026-10-25T02:30:00");
    expect(formatVisitWallClock("2026-08-31T19:00:00")).toContain("19:00");
    expect(formatVisitWallClock("2026-01-15T19:00:00")).toContain("19:00");
  });

  it("fails closed for impossible or timezone-offset visit values", () => {
    expect(normalizeVisitWallClock("2026-02-30T19:00:00")).toBeUndefined();
    expect(normalizeVisitWallClock("2026-08-31T19:00:00+02:00")).toBeUndefined();
  });

  it("prevents an Agent from widening the query to the whole tenant", async () => {
    const tool = createSearchVisitsTool({ port: port() });
    await expect(tool.handler({ timeframe: "today", ownership: "tenant", limit: 50 }, actor("agent")))
      .rejects.toThrow("VISITS_TENANT_SCOPE_FORBIDDEN");
  });

  it("allows an Agent to read a tenant-scoped relation only when an authorized target bounds it", async () => {
    const visitPort = port();
    const tool = createSearchVisitsTool({ port: visitPort });
    await expect(tool.handler({
      timeframe: "all",
      ownership: "tenant",
      lead: { type: "crm.lead", id: "5063" },
      limit: 50,
    }, actor("agent"))).resolves.toBeTruthy();
    expect(visitPort.searchVisits).toHaveBeenCalledTimes(1);
  });
});
