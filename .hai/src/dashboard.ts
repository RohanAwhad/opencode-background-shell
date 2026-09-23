import type {
  ContextKind,
  ContextRecord,
  Evidence,
  Intent,
  IntentLifecycle,
  IntentScope,
  ProjectIndex,
  ProjectState,
} from "./project-state";

export const DEPTHS = ["summary", "decisions", "context", "provenance"] as const;
export type DetailDepth = (typeof DEPTHS)[number];

export interface DashboardFilters {
  query: string;
  scope: IntentScope | "all";
  lifecycle: IntentLifecycle | "all";
}

function evidenceText(evidence: Evidence): string {
  if (evidence.type === "direct_instruction") {
    return `${evidence.source_ref} ${evidence.quote}`;
  }
  if (evidence.type === "proposal") {
    return `${evidence.source_ref} ${evidence.summary}`;
  }

  const selections = Object.entries(evidence.selections ?? {})
    .flatMap(([key, value]) => [key, value])
    .join(" ");
  return `${evidence.source_ref} ${evidence.quote ?? ""} ${selections} ${evidence.proposal_ref ?? ""}`;
}

function contextText(record: ContextRecord): string {
  if (record.kind === "research") {
    return `${record.id} ${record.statement} ${record.basis} ${record.source_ref}`;
  }
  if (record.kind === "assumption") {
    return `${record.id} ${record.statement} ${record.status} ${record.consequence}`;
  }
  return `${record.id} ${record.statement} ${record.source_ref}`;
}

function searchableIntent(state: ProjectState, index: ProjectIndex, intent: Intent): string {
  const approved = [intent, ...(intent.decisions ?? []), ...(intent.instructions ?? [])];
  const evidenceIds = new Set(approved.flatMap((record) => record.evidence));

  for (const evidenceId of [...evidenceIds]) {
    const evidence = state.evidence[evidenceId];
    if (evidence?.type === "explicit_selection" && evidence.proposal_ref !== undefined) {
      evidenceIds.add(evidence.proposal_ref);
    }
  }

  return [
    intent.id,
    intent.statement,
    intent.scope,
    intent.lifecycle,
    ...approved.flatMap((record) => [record.id, record.statement]),
    ...(index.contextByIntentId.get(intent.id) ?? []).map(contextText),
    ...[...evidenceIds].map(
      (evidenceId) => `${evidenceId} ${evidenceText(state.evidence[evidenceId]!)}`,
    ),
  ]
    .join(" ")
    .toLocaleLowerCase();
}

export function filterIntents(
  state: ProjectState,
  index: ProjectIndex,
  filters: DashboardFilters,
): Intent[] {
  const tokens = filters.query
    .trim()
    .toLocaleLowerCase()
    .split(/\s+/)
    .filter(Boolean);

  return state.human_approved.intents.filter((intent) => {
    if (filters.scope !== "all" && intent.scope !== filters.scope) {
      return false;
    }
    if (filters.lifecycle !== "all" && intent.lifecycle !== filters.lifecycle) {
      return false;
    }
    if (tokens.length === 0) {
      return true;
    }
    const searchable = searchableIntent(state, index, intent);
    return tokens.every((token) => searchable.includes(token));
  });
}

export function contextForIntent(
  index: ProjectIndex,
  intentId: string,
  visibleKinds: ReadonlySet<ContextKind>,
): ContextRecord[] {
  return (index.contextByIntentId.get(intentId) ?? []).filter((record) =>
    visibleKinds.has(record.kind),
  );
}

export function evidenceForIntent(state: ProjectState, intent: Intent): string[] {
  const directIds = [intent, ...(intent.decisions ?? []), ...(intent.instructions ?? [])].flatMap(
    (record) => record.evidence,
  );
  const resolvedIds: string[] = [];

  const appendEvidence = (evidenceId: string): void => {
    const evidence = state.evidence[evidenceId];
    if (evidence?.type === "explicit_selection" && evidence.proposal_ref !== undefined) {
      appendEvidence(evidence.proposal_ref);
    }
    if (!resolvedIds.includes(evidenceId)) {
      resolvedIds.push(evidenceId);
    }
  };

  for (const evidenceId of directIds) {
    appendEvidence(evidenceId);
  }

  return resolvedIds;
}
