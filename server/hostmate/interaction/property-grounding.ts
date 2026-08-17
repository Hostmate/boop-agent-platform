import type { EntityRef } from "../contracts/domain.js";
import type { EntityListBlock, EntityListItem } from "../contracts/execution-result.js";
import type { AgentMessageRecord } from "../control-plane/repository.js";
import { groundInteractionDomain, normalizeGroundingText } from "./domain-grounding.js";

export type PropertyGroundingCandidate = Readonly<{
  ref: EntityRef;
  title: string;
  subtitle?: string;
  imageUrl?: string;
  fields: readonly Readonly<{ label: string; value: string }> [];
}>;

export type PropertyGroundingResolution =
  | Readonly<{ kind: "resolved"; ref: EntityRef; candidate?: PropertyGroundingCandidate; reason: "selected" | "ordinal" | "anaphora" | "descriptive" | "reference" }>
  | Readonly<{ kind: "ambiguous"; candidates: readonly PropertyGroundingCandidate[]; question: string; reason: "ordinal" | "anaphora" | "descriptive" | "reference" }>;

const GENERIC_WORDS = new Set([
  "el", "la", "los", "las", "un", "una", "unos", "unas", "de", "del", "en", "con", "por", "para", "que", "y", "o", "a",
  "piso", "pisos", "casa", "casas", "inmueble", "inmuebles", "propiedad", "propiedades", "apartamento", "apartamentos", "atico", "aticos",
  "este", "esta", "ese", "esa", "otro", "otra", "anterior", "primero", "primera", "segundo", "segunda", "tercero", "tercera", "cuarto", "cuarta", "quinto", "quinta",
  "vimos", "visto", "antes", "referia", "referia", "cuanto", "costaba", "vale", "valia", "unos", "unas", "aproximadamente", "aprox", "sobre", "unos",
  "busca", "buscar", "encuentra", "encontrar", "muestra", "muestrame", "dame", "lista", "listar", "quiero", "necesito", "tiene", "tienen", "que", "qué",
  "informacion", "detalle", "detalles", "cuentame", "mas", "precio", "coste", "caracteristicas", "ficha", "comercial", "inmobiliario",
]);

const NUMBER_WORDS: Record<string, number> = {
  cero: 0, una: 1, uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10,
};

function sameRef(left: EntityRef | undefined, right: EntityRef): boolean {
  return left?.type === right.type && left.id === right.id;
}

function candidateFromItem(item: EntityListItem): PropertyGroundingCandidate {
  return { ref: item.ref, title: item.title, subtitle: item.subtitle, imageUrl: item.imageUrl, fields: item.fields };
}

export function propertyGroundingCandidatesFromBlock(block: EntityListBlock): readonly PropertyGroundingCandidate[] {
  return entityListCandidates(block);
}

function entityListCandidates(block: EntityListBlock): PropertyGroundingCandidate[] {
  return block.items.filter((item) => item.ref.type === "property.property").map(candidateFromItem);
}

function uniqueCandidates(candidates: readonly PropertyGroundingCandidate[]): PropertyGroundingCandidate[] {
  return [...new Map(candidates.map((candidate) => [`${candidate.ref.type}:${candidate.ref.id}`, candidate])).values()];
}

function latestPropertyList(messages: readonly AgentMessageRecord[]): PropertyGroundingCandidate[] {
  for (const message of [...messages].reverse()) {
    for (const block of [...(message.blocks ?? [])].reverse()) {
      if (block.type !== "entity_list") continue;
      const candidates = entityListCandidates(block);
      if (candidates.length) return candidates;
    }
  }
  return [];
}

export function propertyGroundingCandidates(messages: readonly AgentMessageRecord[]): readonly PropertyGroundingCandidate[] {
  const latest = latestPropertyList(messages);
  if (latest.length) return latest;
  const candidates: PropertyGroundingCandidate[] = [];
  for (const message of [...messages].reverse()) {
    for (const block of [...(message.blocks ?? [])].reverse()) {
      if (block.type === "entity_list") candidates.push(...entityListCandidates(block));
      if (block.type === "entity_detail" && block.ref.type === "property.property") {
        candidates.push({ ref: block.ref, title: block.title, subtitle: block.subtitle, imageUrl: block.imageUrl, fields: block.sections.flatMap((section) => section.fields) });
      }
    }
  }
  return uniqueCandidates(candidates);
}

function ordinalIndex(message: string): number | undefined {
  const value = normalizeGroundingText(message);
  const ordinals: readonly [RegExp, number][] = [
    [/\b((el|la)\s+)?(primero|primera|1)\b/, 0],
    [/\b((el|la)\s+)?(segundo|segunda|2)\b/, 1],
    [/\b((el|la)\s+)?(tercero|tercera|3)\b/, 2],
    [/\b((el|la)\s+)?(cuarto|cuarta|4)\b/, 3],
    [/\b((el|la)\s+)?(quinto|quinta|5)\b/, 4],
  ];
  return ordinals.find(([pattern]) => pattern.test(value))?.[1];
}

function isOther(message: string): boolean {
  return /\b(el|la)?\s*otro(s)?\b/.test(normalizeGroundingText(message));
}

function isPrevious(message: string): boolean {
  return /\b(el|la)?\s*anterior\b/.test(normalizeGroundingText(message));
}

function isDemonstrative(message: string): boolean {
  const value = normalizeGroundingText(message);
  return /\b(este|esta|ese|esa)\s+(inmueble|piso|casa|propiedad|apartamento|atico)\b/.test(value)
    || /\b(este|esta|ese|esa)\b/.test(value) && /\b(inmueble|piso|casa|propiedad)\b/.test(value);
}

function numericValues(value: string): number[] {
  const text = normalizeGroundingText(value);
  const values: number[] = [];
  for (const match of text.matchAll(/\b(\d[\d\s]*(?:[.,]\d+)?)\s*(k|mil|m)?\b/g)) {
    const raw = (match[1] ?? "").replace(/\s/g, "");
    const suffix = match[2];
    const normalized = suffix ? Number(raw.replace(/[.,]/g, "")) * (suffix === "m" ? 1_000_000 : 1_000) : raw.includes(" ") ? Number(raw.replace(/\s/g, "")) : Number(raw.replace(/([.,])(\d{3})$/, "$2"));
    if (Number.isFinite(normalized)) values.push(normalized);
  }
  for (const [word, number] of Object.entries(NUMBER_WORDS)) if (new RegExp(`\\b${word}\\b`).test(text)) values.push(number);
  return [...new Set(values)];
}

function candidateText(candidate: PropertyGroundingCandidate): string {
  return [candidate.ref.label, candidate.title, candidate.subtitle, ...candidate.fields.map((field) => `${field.label} ${field.value}`)].filter(Boolean).join(" ");
}

function informativeTokens(value: string): string[] {
  return normalizeGroundingText(value).split(" ").filter((token) => token.length >= 3 && !GENERIC_WORDS.has(token));
}

function candidateNumericValues(candidate: PropertyGroundingCandidate): number[] {
  return numericValues(candidateText(candidate));
}

function scoreCandidate(message: string, candidate: PropertyGroundingCandidate): { score: number; overlap: string[]; numeric: number[] } {
  const messageTokens = informativeTokens(message);
  const candidateTokens = new Set(informativeTokens(candidateText(candidate)));
  const overlap = [...new Set(messageTokens.filter((token) => candidateTokens.has(token)))];
  const messageNumbers = numericValues(message);
  const candidateNumbers = candidateNumericValues(candidate);
  const numeric = messageNumbers.filter((value) => candidateNumbers.includes(value));
  return { score: overlap.length * 2 + numeric.length * 3, overlap, numeric };
}

function candidateLabel(candidate: PropertyGroundingCandidate): string {
  const rooms = candidate.fields.find((field) => /habitaciones|dormitorios/i.test(field.label))?.value;
  const location = candidate.subtitle?.split(" · ").filter((part) => !/^\w{2,}-\w+/i.test(part)).slice(-2).join(" · ");
  return [candidate.title, rooms ? `${rooms} habitaciones` : undefined, location].filter(Boolean).join(" · ");
}

export function propertyAmbiguityQuestion(candidates: readonly PropertyGroundingCandidate[]): string {
  const labels = candidates.slice(0, 4).map(candidateLabel);
  return labels.length === 2
    ? `¿Te refieres a ${labels[0]} o a ${labels[1]}?`
    : `Tengo varias opciones que encajan (${labels.join(", ")}). ¿Cuál de ellas quieres decir?`;
}

export function propertyCandidatesBlock(candidates: readonly PropertyGroundingCandidate[]): EntityListBlock {
  return { type: "entity_list", title: candidates.length === 1 ? "Inmueble candidato" : `${candidates.length} inmuebles candidatos`, items: candidates.map((candidate) => ({
    ref: candidate.ref, title: candidate.title, subtitle: candidate.subtitle, imageUrl: candidate.imageUrl, fields: candidate.fields,
  })) };
}

export function isPropertyIdentificationIntent(message: string): boolean {
  const value = normalizeGroundingText(message);
  const grounding = groundInteractionDomain(message);
  const anaphora = isDemonstrative(message) || isOther(message) || isPrevious(message) || ordinalIndex(message) !== undefined || /\b(el|la)\s+de\b/.test(value);
  const lookup = /\b(cuanto|costaba|precio|vale|valia|informacion|detalle|detalles|caracteristicas|superficie|ubicacion|direccion|ficha|cuentame)\b/.test(value);
  const search = /\b(busca|buscar|encuentra|encontrar|muestra|muestrame|lista|listar|localiza|localizar)\b/.test(value);
  return anaphora || (grounding.domain === "property" && (lookup || !search));
}

export function isPropertyDetailIntent(message: string): boolean {
  const value = normalizeGroundingText(message);
  return /\b(cuentame|informacion|detalle|detalles|ficha|precio|costaba|cuanto|vale|valia|caracteristicas|superficie|habitaciones|dormitorios|ubicacion|direccion)\b/.test(value);
}

export function resolvePropertyMention(input: {
  message: string;
  messages: readonly AgentMessageRecord[];
  selected?: EntityRef;
  candidates?: readonly PropertyGroundingCandidate[];
}): PropertyGroundingResolution | undefined {
  const value = normalizeGroundingText(input.message);
  const candidates = uniqueCandidates(input.candidates ?? propertyGroundingCandidates(input.messages));
  const selected = input.selected?.type === "property.property" ? input.selected : undefined;
  const list = candidates;
  const index = ordinalIndex(input.message);
  if (index !== undefined) {
    const candidate = list[index];
    if (candidate) return { kind: "resolved", ref: candidate.ref, candidate, reason: "ordinal" };
    return list.length ? { kind: "ambiguous", candidates: list, question: propertyAmbiguityQuestion(list), reason: "ordinal" } : undefined;
  }
  if (isPrevious(input.message)) {
    const selectedIndex = selected ? list.findIndex((candidate) => sameRef(candidate.ref, selected)) : -1;
    if (selectedIndex > 0) {
      const candidate = list[selectedIndex - 1]!;
      return { kind: "resolved", ref: candidate.ref, candidate, reason: "anaphora" };
    }
    if (list.length === 1 && !selected) return { kind: "resolved", ref: list[0]!.ref, candidate: list[0], reason: "anaphora" };
    return list.length ? { kind: "ambiguous", candidates: list, question: propertyAmbiguityQuestion(list), reason: "anaphora" } : undefined;
  }
  if (isOther(input.message)) {
    const alternatives = selected ? list.filter((candidate) => !sameRef(candidate.ref, selected)) : list;
    if (alternatives.length === 1) return { kind: "resolved", ref: alternatives[0]!.ref, candidate: alternatives[0], reason: "anaphora" };
    if (alternatives.length > 1) return { kind: "ambiguous", candidates: alternatives, question: propertyAmbiguityQuestion(alternatives), reason: "anaphora" };
  }
  if (isDemonstrative(input.message) && selected) return { kind: "resolved", ref: selected, candidate: list.find((candidate) => sameRef(candidate.ref, selected)), reason: "selected" };
  if (!isPropertyIdentificationIntent(input.message) || !list.length) return undefined;

  const scored = list.map((candidate) => ({ candidate, ...scoreCandidate(input.message, candidate) })).filter((entry) => entry.score > 0);
  if (!scored.length) return undefined;
  const bestScore = Math.max(...scored.map((entry) => entry.score));
  const best = scored.filter((entry) => entry.score === bestScore);
  const exactReferenceMatches = scored.filter((entry) => {
    const reference = entry.candidate.subtitle?.split(" · ")[0] ?? entry.candidate.ref.label ?? "";
    return reference.length >= 3 && value.includes(normalizeGroundingText(reference));
  });
  if (exactReferenceMatches.length === 1) {
    return { kind: "resolved", ref: exactReferenceMatches[0]!.candidate.ref, candidate: exactReferenceMatches[0]!.candidate, reason: "reference" };
  }
  const hasReference = best.some((entry) => {
    const reference = entry.candidate.subtitle?.split(" · ")[0] ?? entry.candidate.ref.label ?? "";
    return reference.length >= 3 && value.includes(normalizeGroundingText(reference));
  });
  if (best.length === 1 && (bestScore >= 2 || hasReference)) {
    const entry = best[0]!;
    return { kind: "resolved", ref: entry.candidate.ref, candidate: entry.candidate, reason: hasReference ? "reference" : "descriptive" };
  }
  return { kind: "ambiguous", candidates: best.map((entry) => entry.candidate), question: propertyAmbiguityQuestion(best.map((entry) => entry.candidate)), reason: hasReference ? "reference" : "descriptive" };
}
