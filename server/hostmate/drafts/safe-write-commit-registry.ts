import type { ActorContext } from "../contracts/actor-context.js";
import type { EntityRef } from "../contracts/domain.js";
import type { SignedWriteIntent } from "./contracts.js";

export type SafeWriteCommitResult = Readonly<{
  outcome: "committed";
  idempotent: boolean;
  entity?: EntityRef;
  details?: Readonly<Record<string, unknown>>;
}>;

export type SafeWriteCommitErrorCode = "NOT_FOUND" | "PERMISSION_DENIED" | "STALE_REFERENCE" | "PRECONDITION_FAILED" | "CONFLICT";

export class SafeWriteCommitError extends Error {
  constructor(public readonly code: SafeWriteCommitErrorCode, message: string) {
    super(message);
    this.name = "SafeWriteCommitError";
  }
}

export type SafeWriteCommitDefinition = Readonly<{
  toolId: string;
  toolVersion: number;
  requiredPermission: string;
  operationType: "update" | "create";
  operation: string;
  commit(actor: ActorContext, intent: SignedWriteIntent): Promise<SafeWriteCommitResult>;
}>;

export class SafeWriteCommitRegistry {
  private readonly definitions: ReadonlyMap<string, SafeWriteCommitDefinition>;

  constructor(definitions: readonly SafeWriteCommitDefinition[]) {
    const byId = new Map<string, SafeWriteCommitDefinition>();
    for (const definition of definitions) {
      if (byId.has(definition.toolId)) throw new Error(`Duplicate Safe Write definition: ${definition.toolId}`);
      byId.set(definition.toolId, Object.freeze(definition));
    }
    this.definitions = byId;
  }

  resolve(intent: SignedWriteIntent): SafeWriteCommitDefinition {
    const definition = this.definitions.get(intent.envelope.toolId);
    if (!definition
      || intent.envelope.toolVersion !== definition.toolVersion
      || intent.envelope.toolScope.length !== 1
      || intent.envelope.toolScope[0] !== `${definition.toolId}@${definition.toolVersion}`
      || intent.envelope.operationType !== definition.operationType
      || intent.envelope.operation !== definition.operation) {
      throw new Error("DRAFT_DEFINITION_MISMATCH");
    }
    return definition;
  }
}
