import { z } from "zod";
import type { AgentError, EntityRef } from "./domain.js";

export type EntityListItem = Readonly<{
  ref: EntityRef;
  title: string;
  subtitle?: string;
  imageUrl?: string;
  fields: ReadonlyArray<Readonly<{ label: string; value: string }>>;
}>;

export type AgentContentBlock = Readonly<{
  type: "entity_list";
  title: string;
  items: readonly EntityListItem[];
}>;

export type ExecutionResultStatus = "completed" | "needs_input" | "failed" | "permission_denied";

export type ExecutionResult<TData = unknown> = Readonly<{
  status: ExecutionResultStatus;
  summary: string;
  entities: readonly EntityRef[];
  data?: TData;
  blocks?: readonly AgentContentBlock[];
  errors: readonly AgentError[];
  suggestedNext?: readonly string[];
}>;

export const entityRefSchema = z.object({
  type: z.string().min(1).max(64),
  id: z.string().min(1).max(128),
  label: z.string().min(1).max(160).optional(),
  deepLink: z.string().min(1).max(512).optional(),
}).strict();

export const executionResultStatusSchema = z.enum(["completed", "needs_input", "failed", "permission_denied"]);
