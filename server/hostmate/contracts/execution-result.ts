import { z } from "zod";
import type { AgentError, EntityRef } from "./domain.js";

export type EntityListItem = Readonly<{
  ref: EntityRef;
  title: string;
  subtitle?: string;
  imageUrl?: string;
  fields: ReadonlyArray<Readonly<{ label: string; value: string }>>;
}>;

export type EntityListBlock = Readonly<{
  type: "entity_list";
  title: string;
  items: readonly EntityListItem[];
}>;

export type EntityDetailBlock = Readonly<{
  type: "entity_detail";
  title: string;
  ref: EntityRef;
  subtitle?: string;
  imageUrl?: string;
  gallery?: readonly Readonly<{ url: string; thumbnailUrl?: string; caption?: string }>[];
  badges?: readonly string[];
  description?: string;
  sections: readonly Readonly<{
    title: string;
    fields: readonly Readonly<{ label: string; value: string }>[];
  }>[];
  actions?: readonly Readonly<{ label: string; href: string }>[];
}>;

export type BriefBlock = Readonly<{
  type: "brief";
  title: string;
  status: "complete" | "partial";
  sections: readonly Readonly<{
    key: "visit" | "lead" | "commercial" | "property" | "preparation";
    title: string;
    availability: "available" | "unavailable";
    fields: readonly Readonly<{ label: string; value: string }>[];
    notes?: readonly string[];
  }>[];
}>;

export type AgentContentBlock = EntityListBlock | EntityDetailBlock | BriefBlock;

export type ExecutionResultStatus = "completed" | "partial" | "needs_input" | "failed" | "permission_denied";

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

export const executionResultStatusSchema = z.enum(["completed", "partial", "needs_input", "failed", "permission_denied"]);
