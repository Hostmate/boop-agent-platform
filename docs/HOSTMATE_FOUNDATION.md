# Hostmate Agent Platform Foundation

This fork is pinned to the audited Boop baseline and adds a downstream Foundation without converting Boop into a generic workflow engine.

## Implemented contracts

- immutable, server-created `ActorContext`;
- `ControlPlaneRepository` and Convex adapter;
- tenant-first Convex runs, attempts, events and usage;
- run/attempt lifecycle with lease, heartbeat and fencing contracts;
- durable cancellation request and conservative retry rules;
- universal redacted `AgentEvent` envelope;
- eight versioned Execution Profiles;
- Skill Registry with required capability checks and hashes;
- Product Tool Registry with Zod schemas, reducer-only resolution and ActorContext closure;
- backend Policy Engine;
- Signed Draft state machine, argument hashes and one-shot confirmation checks;
- OpenRouter streaming/tool adapter with Zod validation, provider/fallback metadata, usage/cost/reasoning/cache, normalized errors, cancellation, timeout and budgets.

No Real Estate domain tool handler is registered in this phase. The registry and policy boundaries exist so the next vertical slice can add a read-only capability without bypassing Domain Services.

## Runtime flow

```text
Hostmate request/session
  -> ActorContext (server only)
  -> Interaction dispatch
  -> profile + objective class
  -> Tool Registry reduction
  -> Skill resolution
  -> Policy preflight
  -> Execution Run + Attempt in Convex
  -> OpenRouterAdapter
  -> RuntimeTool wrapper (ActorContext closure)
  -> future Domain Service handler
```

## Configuration

Convex auth config requires `HOSTMATE_CONVEX_JWT_ISSUER`, `HOSTMATE_CONVEX_JWT_AUDIENCE` and `HOSTMATE_CONVEX_JWKS_URL`.

The Hostmate API bridge is disabled unless `AGENT_PLATFORM_ENABLED=true` and requires its Convex URL, issuer, audience, key ID and managed RS256 private key configuration. No production value is committed to either repository.

OpenRouterAdapter receives API key, model, fallbacks, provider policy and budgets from its caller. It intentionally has no default model.
