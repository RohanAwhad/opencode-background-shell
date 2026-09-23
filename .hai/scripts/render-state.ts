import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { contextForIntent, evidenceForIntent } from "../src/dashboard";
import type { ContextKind, ContextRecord, Evidence, Intent, ProjectIndex, ProjectState } from "../src/project-state";
import { buildProjectIndex, parseProjectState } from "../src/project-state";
import { readTextFile } from "./state-file";

const DEPTH_SUMMARY = 1;
const DEPTH_DECISIONS = 2;
const DEPTH_CONTEXT = 3;
const DEPTH_PROVENANCE = 4;

const KIND_ORDER: ReadonlyArray<{ kind: ContextKind; label: string }> = [
  { kind: "research", label: "Research" },
  { kind: "assumption", label: "Assumptions" },
  { kind: "observation", label: "Observations" },
  { kind: "unapproved_action", label: "Unapproved actions" },
];

const ALL_KINDS = new Set(KIND_ORDER.map((entry) => entry.kind)) as ReadonlySet<ContextKind>;

export function renderSummaryView(
  state: ProjectState,
  index: ProjectIndex,
  intents: readonly Intent[],
): string {
  return renderBlocks(state, index, intents, DEPTH_SUMMARY);
}

export function renderDecisionsView(
  state: ProjectState,
  index: ProjectIndex,
  intents: readonly Intent[],
): string {
  return renderBlocks(state, index, intents, DEPTH_DECISIONS);
}

export function renderContextView(
  state: ProjectState,
  index: ProjectIndex,
  intents: readonly Intent[],
): string {
  return renderBlocks(state, index, intents, DEPTH_CONTEXT);
}

export function renderProvenanceView(
  state: ProjectState,
  index: ProjectIndex,
  intents: readonly Intent[],
): string {
  return renderBlocks(state, index, intents, DEPTH_PROVENANCE);
}

export function renderReadmeView(state: ProjectState): string {
  const decisionLines: string[] = [];
  for (const intent of state.human_approved.intents) {
    decisionLines.push(`- ${intent.statement}`);
    for (const decision of intent.decisions ?? []) {
      decisionLines.push(`  - ${decision.statement}`);
    }
    for (const instruction of intent.instructions ?? []) {
      decisionLines.push(`  - ${instruction.statement}`);
    }
  }

  const assumptionLines: string[] = [];
  for (const assumption of state.agent_context.assumptions) {
    assumptionLines.push(`- ${assumption.statement}`);
    assumptionLines.push(`  Consequence: ${assumption.consequence}`);
  }

  const researchLines = [
    ...state.agent_context.research.map((record) => `- ${record.id}: ${record.statement}`),
    ...state.agent_context.observations.map((record) => `- ${record.id}: ${record.statement}`),
    ...state.agent_context.unapproved_actions.map((record) => `- ${record.id}: ${record.statement}`),
  ];

  return [
    "## Human Decisions",
    "",
    decisionLines.join("\n"),
    "",
    "## Agent Assumptions",
    "",
    assumptionLines.join("\n"),
    "",
    "## Agent Research and Observations",
    "",
    researchLines.join("\n"),
    "",
  ].join("\n");
}

function renderBlocks(
  state: ProjectState,
  index: ProjectIndex,
  intents: readonly Intent[],
  depth: number,
): string {
  const numbered = intents.length > 1;
  return intents
    .map((intent, position) => renderIntentBlock(state, index, intent, position + 1, numbered, depth))
    .join("\n\n") + "\n";
}

function renderIntentBlock(
  state: ProjectState,
  index: ProjectIndex,
  intent: Intent,
  position: number,
  numbered: boolean,
  depth: number,
): string {
  const lines: string[] = [];
  const prefix = numbered ? `${position}. ` : "";
  lines.push(`## ${prefix}${intent.id} — ${intent.statement}`);
  lines.push(`Scope: ${intent.scope}`);
  lines.push(`Lifecycle: ${intent.lifecycle}`);
  lines.push(
    `Commitments: ${intent.decisions?.length ?? 0} ${plural(intent.decisions?.length ?? 0, "decision")}, ` +
      `${intent.instructions?.length ?? 0} ${plural(intent.instructions?.length ?? 0, "instruction")}`,
  );

  const evidenceIds = evidenceForIntent(state, intent);
  lines.push(`Evidence: ${evidenceIds.join(", ")}`);

  const census = KIND_ORDER.map(
    (entry) => `${entry.label} ${contextForIntent(index, intent.id, new Set([entry.kind])).length}`,
  );
  lines.push(`Linked context: ${census.join(", ")}`);

  if (depth >= DEPTH_DECISIONS) {
    const decisionLines = (intent.decisions ?? []).map(
      (record) => `- ${record.id}: ${record.statement}`,
    );
    if (decisionLines.length > 0) {
      lines.push("", "### Decisions", ...decisionLines);
    }
    const instructionLines = (intent.instructions ?? []).map(
      (record) => `- ${record.id}: ${record.statement}`,
    );
    if (instructionLines.length > 0) {
      lines.push("", "### Instructions", ...instructionLines);
    }
  }

  if (depth >= DEPTH_CONTEXT) {
    lines.push("", "### Context");
    for (const entry of KIND_ORDER) {
      const records = contextForIntent(index, intent.id, new Set([entry.kind]));
      if (records.length === 0) {
        continue;
      }
      lines.push(`${entry.label}:`);
      for (const record of records) {
        lines.push(`- ${record.id}: ${record.statement}`);
        lines.push(...contextDetailLines(record));
      }
    }
  }

  if (depth >= DEPTH_PROVENANCE && evidenceIds.length > 0) {
    lines.push("", "### Evidence");
    for (const evidenceId of evidenceIds) {
      lines.push("", ...evidenceBlock(state, evidenceId));
    }
  }

  return lines.join("\n");
}

function contextDetailLines(record: ContextRecord): string[] {
  if (record.kind === "research") {
    return [`  Basis: ${record.basis}`, `  Source: ${record.source_ref}`];
  }
  if (record.kind === "assumption") {
    return [`  Status: ${record.status}`, `  Consequence: ${record.consequence}`];
  }
  return [`  Source: ${record.source_ref}`];
}

function evidenceBlock(state: ProjectState, evidenceId: string): string[] {
  const evidence = state.evidence[evidenceId];
  if (evidence === undefined) {
    return [`### Evidence ${evidenceId} (unknown)`];
  }
  const lines = [`### Evidence ${evidenceId} (${evidence.actor} / ${evidence.type})`];
  if (evidence.type === "direct_instruction") {
    lines.push(`Source: ${evidence.source_ref}`, ...blockquote(evidence.quote));
  } else if (evidence.type === "proposal") {
    lines.push(`Source: ${evidence.source_ref}`, `Summary: ${evidence.summary}`);
  } else {
    lines.push(`Source: ${evidence.source_ref}`);
    if (evidence.quote !== undefined) {
      lines.push(...blockquote(evidence.quote));
    }
    const selections = Object.entries(evidence.selections ?? {});
    if (selections.length > 0) {
      lines.push("Selections:");
      for (const [key, value] of selections) {
        lines.push(`- ${key}: ${value}`);
      }
    }
    if (evidence.proposal_ref !== undefined) {
      const proposal = state.evidence[evidence.proposal_ref];
      const summary = proposal?.type === "proposal" ? proposal.summary : "";
      lines.push(`Proposal chain: ${evidence.proposal_ref} — ${summary}`);
    }
  }
  return lines;
}

function blockquote(text: string): string[] {
  return text.split("\n").map((line) => `> ${line}`);
}

function plural(count: number, word: string): string {
  return count === 1 ? word : `${word}s`;
}

function renderStateView(
  state: ProjectState,
  index: ProjectIndex,
  view: string,
  intents: readonly Intent[],
): string {
  switch (view) {
    case "summary":
      return renderSummaryView(state, index, intents);
    case "decisions":
      return renderDecisionsView(state, index, intents);
    case "context":
      return renderContextView(state, index, intents);
    case "provenance":
      return renderProvenanceView(state, index, intents);
    default:
      throw new Error(`unknown view: ${view}`);
  }
}

function runCli(): void {
  const argv = process.argv.slice(2);
  let yamlPath = "example-state.yaml";
  let view = "summary";
  let intentId: string | undefined;
  let outPath: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--view") {
      view = argv[i + 1] ?? "";
      i += 1;
    } else if (arg === "--intent") {
      intentId = argv[i + 1];
      i += 1;
    } else if (arg === "--out") {
      outPath = argv[i + 1];
      i += 1;
    } else if (arg !== undefined && !arg.startsWith("-")) {
      yamlPath = arg;
    }
  }

  const state = parseProjectState(readTextFile(yamlPath));
  const index = buildProjectIndex(state);

  let output: string;
  if (view === "readme") {
    output = renderReadmeView(state);
  } else if (view !== "summary" && view !== "decisions" && view !== "context" && view !== "provenance") {
    console.error(`unknown view: ${view}`);
    process.exitCode = 1;
    return;
  } else {
    const intents =
      intentId === undefined
        ? state.human_approved.intents
        : [index.intentById.get(intentId)];
    if (intents[0] === undefined) {
      console.error(`intent not found: ${intentId}`);
      process.exitCode = 1;
      return;
    }
    output = renderStateView(state, index, view, intents as Intent[]);
  }

  if (outPath !== undefined) {
    writeFileSync(outPath, output, "utf8");
  } else {
    console.log(output);
  }
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    runCli();
  } catch (error) {
    console.error(`invalid: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
