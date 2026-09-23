import { describe, expect, it } from "vitest";
import source from "../example-state.yaml?raw";
import {
  buildProjectIndex,
  parseProjectState,
  StateValidationError,
} from "../src/project-state";
import {
  renderDecisionsView,
  renderProvenanceView,
  renderReadmeView,
  renderSummaryView,
} from "../scripts/render-state";

function stateAndIndex() {
  const state = parseProjectState(source);
  const index = buildProjectIndex(state);
  return { state, index };
}

function intentById(id: string) {
  const { state, index } = stateAndIndex();
  const intent = index.intentById.get(id);
  if (intent === undefined) {
    throw new Error(`intent ${id} not found`);
  }
  return { state, index, intent };
}

describe("scripts/render-state views", () => {
  it("readme view emits the README artifact sections", () => {
    const { state } = stateAndIndex();
    const readme = renderReadmeView(state);

    expect(readme).toContain("## Human Decisions");
    expect(readme).toContain("## Agent Assumptions");
    expect(readme).toContain("## Agent Research and Observations");
    expect(readme).toContain("abhi1092");
    expect(readme).toContain("dead_letter");
    expect(readme).toContain("Run builder and reviewer subagents");
    expect(readme).toContain("Commit and push");
  });

  it("readme view orders sections deterministically", () => {
    const { state } = stateAndIndex();
    const readme = renderReadmeView(state);

    const humanIndex = readme.indexOf("## Human Decisions");
    const assumptionsIndex = readme.indexOf("## Agent Assumptions");
    const researchIndex = readme.indexOf("## Agent Research and Observations");
    expect(humanIndex).toBeGreaterThanOrEqual(0);
    expect(assumptionsIndex).toBeGreaterThan(humanIndex);
    expect(researchIndex).toBeGreaterThan(assumptionsIndex);
  });

  it("decisions view for INT-002 contains every DEC statement", () => {
    const { state, index, intent } = intentById("INT-002");
    const view = renderDecisionsView(state, index, [intent]);

    expect(view).toContain("Represent the DLQ using status=dead_letter and a failure_reason column on the existing code_review_jobs row.");
    expect(view).toContain("Do not create a separate DLQ table or queue.");
    expect(view).toContain("Route every review-job failure to the DLQ.");
    expect(view).toContain("Dead-lettered jobs are terminal, receive no automatic retry, and remain parked for manual inspection or redrive.");
  });

  it("provenance view for INT-002 lists linked context ids", () => {
    const { state, index, intent } = intentById("INT-002");
    const view = renderProvenanceView(state, index, [intent]);

    expect(view).toContain("RES-003:");
    expect(view).toContain("RES-004:");
    expect(view).toContain("ASM-001:");
    expect(view).toContain("### Evidence H1 (human / direct_instruction)");
    expect(view).toContain("### Evidence H2 (human / explicit_selection)");
    expect(view).not.toContain("### Evidence A1");
  });

  it("provenance view for INT-004 resolves the proposal chain A1 before H6", () => {
    const { state, index, intent } = intentById("INT-004");
    const view = renderProvenanceView(state, index, [intent]);

    const a1Index = view.indexOf("### Evidence A1 (agent / proposal)");
    const h6Index = view.indexOf("### Evidence H6 (human / explicit_selection)");
    expect(a1Index).toBeGreaterThanOrEqual(0);
    expect(h6Index).toBeGreaterThan(a1Index);
    expect(view).toContain("Proposal chain: A1 — Option 1 was a one-off code_review_jobs insert");
  });

  it("summary view stays minimal without nested sections", () => {
    const { state, index } = stateAndIndex();
    const view = renderSummaryView(state, index, state.human_approved.intents);

    expect(view).toContain("## 1. INT-001 — Review PRs authored by abhi1092.");
    expect(view).toContain("Scope: project");
    expect(view).toContain("Linked context: Research 2, Assumptions 1, Observations 0, Unapproved actions 0");
    expect(view).not.toContain("### Decisions");
    expect(view).not.toContain("### Evidence");
  });

  it("renders the same view deterministically", () => {
    const { state, index } = stateAndIndex();

    expect(renderReadmeView(state)).toBe(renderReadmeView(state));

    const intent = index.intentById.get("INT-002");
    if (intent === undefined) {
      throw new Error("INT-002 not found");
    }
    expect(renderDecisionsView(state, index, [intent])).toBe(
      renderDecisionsView(state, index, [intent]),
    );
    expect(renderProvenanceView(state, index, state.human_approved.intents)).toBe(
      renderProvenanceView(state, index, state.human_approved.intents),
    );
  });
});

describe("scripts validate logic", () => {
  it("throws StateValidationError on garbage YAML", () => {
    expect(() => parseProjectState("schema_version: [unclosed")).toThrow(StateValidationError);
  });

  it("throws StateValidationError when evidence map is missing", () => {
    const invalid = source.replace("evidence:\n", "");
    expect(invalid.length).toBeLessThan(source.length);
    expect(() => parseProjectState(invalid)).toThrow(StateValidationError);
  });

  it("throws StateValidationError on dangling approved evidence", () => {
    expect(() => parseProjectState(source.replace("evidence: [H1]", "evidence: [MISSING]"))).toThrow(
      /unknown evidence MISSING/,
    );
  });
});
