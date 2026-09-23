import { parseDocument } from "yaml";
import { z } from "zod";

const nonEmptyString = z.string().refine((value) => value.trim().length > 0, {
  message: "Expected a non-empty string",
});

const directInstructionSchema = z
  .object({
    actor: z.literal("human"),
    type: z.literal("direct_instruction"),
    source_ref: nonEmptyString,
    quote: nonEmptyString,
  })
  .strict();

const explicitSelectionSchema = z
  .object({
    actor: z.literal("human"),
    type: z.literal("explicit_selection"),
    source_ref: nonEmptyString,
    quote: nonEmptyString.optional(),
    selections: z.record(nonEmptyString, nonEmptyString).optional(),
    proposal_ref: nonEmptyString.optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.quote !== undefined || Object.keys(value.selections ?? {}).length > 0,
    {
    message: "An explicit selection needs a quote or selections",
    },
  );

const agentProposalSchema = z
  .object({
    actor: z.literal("agent"),
    type: z.literal("proposal"),
    source_ref: nonEmptyString,
    summary: nonEmptyString,
  })
  .strict();

const evidenceSchema = z.discriminatedUnion("type", [
  directInstructionSchema,
  explicitSelectionSchema,
  agentProposalSchema,
]);

const approvedRecordSchema = z
  .object({
    id: nonEmptyString,
    statement: nonEmptyString,
    evidence: z.array(nonEmptyString).min(1),
  })
  .strict();

const intentSchema = approvedRecordSchema
  .extend({
    scope: z.enum(["project", "session_workflow", "one_shot_operation"]),
    lifecycle: z.enum(["active", "completed", "running_at_capture"]),
    decisions: z.array(approvedRecordSchema).optional(),
    instructions: z.array(approvedRecordSchema).optional(),
  })
  .strict();

const contextBaseSchema = z.object({
  id: nonEmptyString,
  intent_ids: z.array(nonEmptyString).min(1),
  statement: nonEmptyString,
});

const researchSchema = contextBaseSchema
  .extend({
    basis: nonEmptyString,
    source_ref: nonEmptyString,
  })
  .strict();

const assumptionSchema = contextBaseSchema
  .extend({
    status: z.enum(["unverified", "agent_derived"]),
    consequence: nonEmptyString,
  })
  .strict();

const observationSchema = contextBaseSchema
  .extend({
    source_ref: nonEmptyString,
  })
  .strict();

const unapprovedActionSchema = contextBaseSchema
  .extend({
    source_ref: nonEmptyString,
  })
  .strict();

const projectStateSchema = z
  .object({
    schema_version: z.literal("0.1"),
    project: z
      .object({
        id: nonEmptyString,
        root: nonEmptyString,
      })
      .strict(),
    snapshot: z
      .object({
        source_session: nonEmptyString,
        captured_through: nonEmptyString,
        semantics: z.literal("current_state_at_capture"),
        superseded_entries: z.literal("omitted"),
        historical_source: z.literal("git"),
      })
      .strict(),
    evidence: z.record(nonEmptyString, evidenceSchema),
    human_approved: z
      .object({
        intents: z.array(intentSchema),
      })
      .strict(),
    agent_context: z
      .object({
        research: z.array(researchSchema),
        assumptions: z.array(assumptionSchema),
        observations: z.array(observationSchema),
        unapproved_actions: z.array(unapprovedActionSchema),
      })
      .strict(),
    open_questions: z.array(nonEmptyString),
  })
  .strict();

export type Evidence = z.infer<typeof evidenceSchema>;
export type ApprovedRecord = z.infer<typeof approvedRecordSchema>;
export type Intent = z.infer<typeof intentSchema>;
export type IntentScope = Intent["scope"];
export type IntentLifecycle = Intent["lifecycle"];
export type Research = z.infer<typeof researchSchema>;
export type Assumption = z.infer<typeof assumptionSchema>;
export type Observation = z.infer<typeof observationSchema>;
export type UnapprovedAction = z.infer<typeof unapprovedActionSchema>;
export type ProjectState = z.infer<typeof projectStateSchema>;
export type ContextKind =
  | "research"
  | "assumption"
  | "observation"
  | "unapproved_action";

export type ContextRecord =
  | (Research & { kind: "research" })
  | (Assumption & { kind: "assumption" })
  | (Observation & { kind: "observation" })
  | (UnapprovedAction & { kind: "unapproved_action" });

export interface ProjectStateCounts {
  intents: number;
  decisions: number;
  instructions: number;
  research: number;
  assumptions: number;
  observations: number;
  unapprovedActions: number;
  evidence: number;
  openQuestions: number;
}

export interface ProjectIndex {
  intentById: ReadonlyMap<string, Intent>;
  context: readonly ContextRecord[];
  contextByIntentId: ReadonlyMap<string, readonly ContextRecord[]>;
}

export class StateValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StateValidationError";
  }
}

function assertUnique(values: readonly string[], path: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      throw new StateValidationError(`${path}: duplicate reference ${value}`);
    }
    seen.add(value);
  }
}

function validateState(state: ProjectState): void {
  const evidenceIds = new Set(Object.keys(state.evidence));
  const intentIds = new Set(state.human_approved.intents.map((intent) => intent.id));
  const records: Array<{ path: string; record: ApprovedRecord }> = [];

  state.human_approved.intents.forEach((intent, intentIndex) => {
    records.push({ path: `human_approved.intents.${intentIndex}`, record: intent });
    intent.decisions?.forEach((record, recordIndex) => {
      records.push({
        path: `human_approved.intents.${intentIndex}.decisions.${recordIndex}`,
        record,
      });
    });
    intent.instructions?.forEach((record, recordIndex) => {
      records.push({
        path: `human_approved.intents.${intentIndex}.instructions.${recordIndex}`,
        record,
      });
    });
  });

  const context = buildContext(state);
  const allRecordIds = [...records.map(({ record }) => record.id), ...context.map((item) => item.id)];
  assertUnique(allRecordIds, "records");

  for (const { path, record } of records) {
    assertUnique(record.evidence, `${path}.evidence`);
    for (const evidenceId of record.evidence) {
      if (!evidenceIds.has(evidenceId)) {
        throw new StateValidationError(`${path}.evidence: unknown evidence ${evidenceId}`);
      }
    }
    const hasHumanAuthority = record.evidence.some(
      (evidenceId) => state.evidence[evidenceId]?.actor === "human",
    );
    if (!hasHumanAuthority) {
      throw new StateValidationError(`${path}: approved records need direct human evidence`);
    }
  }

  const reachableEvidence = new Set(records.flatMap(({ record }) => record.evidence));
  for (const evidenceId of reachableEvidence) {
    const evidence = state.evidence[evidenceId];
    if (evidence?.type === "explicit_selection" && evidence.proposal_ref !== undefined) {
      reachableEvidence.add(evidence.proposal_ref);
    }
  }
  for (const evidenceId of evidenceIds) {
    if (!reachableEvidence.has(evidenceId)) {
      throw new StateValidationError(`evidence.${evidenceId}: evidence is not used`);
    }
  }

  for (const [evidenceId, evidence] of Object.entries(state.evidence)) {
    if (evidence.type !== "explicit_selection" || evidence.proposal_ref === undefined) {
      continue;
    }
    const proposal = state.evidence[evidence.proposal_ref];
    if (proposal?.type !== "proposal" || proposal.actor !== "agent") {
      throw new StateValidationError(
        `evidence.${evidenceId}.proposal_ref: expected an agent proposal`,
      );
    }
  }

  const contextWithPaths: Array<{ path: string; record: ContextRecord }> = [
    ...state.agent_context.research.map((record, recordIndex) => ({
      path: `agent_context.research.${recordIndex}`,
      record: { ...record, kind: "research" as const },
    })),
    ...state.agent_context.assumptions.map((record, recordIndex) => ({
      path: `agent_context.assumptions.${recordIndex}`,
      record: { ...record, kind: "assumption" as const },
    })),
    ...state.agent_context.observations.map((record, recordIndex) => ({
      path: `agent_context.observations.${recordIndex}`,
      record: { ...record, kind: "observation" as const },
    })),
    ...state.agent_context.unapproved_actions.map((record, recordIndex) => ({
      path: `agent_context.unapproved_actions.${recordIndex}`,
      record: { ...record, kind: "unapproved_action" as const },
    })),
  ];

  contextWithPaths.forEach(({ path, record }) => {
    assertUnique(record.intent_ids, `${path}.intent_ids`);
    for (const intentId of record.intent_ids) {
      if (!intentIds.has(intentId)) {
        throw new StateValidationError(`${path}.intent_ids: unknown intent ${intentId}`);
      }
    }
  });
}

export function parseProjectState(source: string): ProjectState {
  const document = parseDocument(source, { uniqueKeys: true });
  const parserMessages = [...document.errors, ...document.warnings];
  if (parserMessages.length > 0) {
    throw new StateValidationError(parserMessages.map((error) => error.message).join("; "));
  }

  const result = projectStateSchema.safeParse(document.toJS({ maxAliasCount: 100 }));
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
      .join("; ");
    throw new StateValidationError(details);
  }

  validateState(result.data);
  return result.data;
}

function buildContext(state: ProjectState): ContextRecord[] {
  return [
    ...state.agent_context.research.map((record) => ({ ...record, kind: "research" as const })),
    ...state.agent_context.assumptions.map((record) => ({
      ...record,
      kind: "assumption" as const,
    })),
    ...state.agent_context.observations.map((record) => ({
      ...record,
      kind: "observation" as const,
    })),
    ...state.agent_context.unapproved_actions.map((record) => ({
      ...record,
      kind: "unapproved_action" as const,
    })),
  ];
}

export function buildProjectIndex(state: ProjectState): ProjectIndex {
  const context = buildContext(state);
  const contextByIntentId = new Map<string, ContextRecord[]>();

  for (const record of context) {
    for (const intentId of record.intent_ids) {
      const records = contextByIntentId.get(intentId) ?? [];
      records.push(record);
      contextByIntentId.set(intentId, records);
    }
  }

  return {
    intentById: new Map(state.human_approved.intents.map((intent) => [intent.id, intent])),
    context,
    contextByIntentId,
  };
}

export function countProjectState(state: ProjectState): ProjectStateCounts {
  return {
    intents: state.human_approved.intents.length,
    decisions: state.human_approved.intents.reduce(
      (count, intent) => count + (intent.decisions?.length ?? 0),
      0,
    ),
    instructions: state.human_approved.intents.reduce(
      (count, intent) => count + (intent.instructions?.length ?? 0),
      0,
    ),
    research: state.agent_context.research.length,
    assumptions: state.agent_context.assumptions.length,
    observations: state.agent_context.observations.length,
    unapprovedActions: state.agent_context.unapproved_actions.length,
    evidence: Object.keys(state.evidence).length,
    openQuestions: state.open_questions.length,
  };
}
