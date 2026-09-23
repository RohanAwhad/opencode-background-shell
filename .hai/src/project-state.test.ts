import { describe, expect, it } from "vitest";
import source from "../example-state.yaml?raw";
import {
  buildProjectIndex,
  countProjectState,
  parseProjectState,
  StateValidationError,
} from "./project-state";

describe("project state", () => {
  it("parses and counts the real snapshot", () => {
    const state = parseProjectState(source);

    expect(countProjectState(state)).toEqual({
      intents: 4,
      decisions: 6,
      instructions: 4,
      research: 6,
      assumptions: 2,
      observations: 2,
      unapprovedActions: 2,
      evidence: 7,
      openQuestions: 0,
    });
  });

  it("indexes shared context under every declared intent", () => {
    const state = parseProjectState(source);
    const index = buildProjectIndex(state);

    expect(index.contextByIntentId.get("INT-001")?.map((record) => record.id)).toEqual([
      "RES-001",
      "RES-002",
      "ASM-001",
    ]);
    expect(index.contextByIntentId.get("INT-002")?.map((record) => record.id)).toEqual([
      "RES-003",
      "RES-004",
      "ASM-001",
      "ASM-002",
    ]);
  });

  it("rejects unsupported schema versions", () => {
    expect(() => parseProjectState(source.replace('schema_version: "0.1"', 'schema_version: "9"'))).toThrow(
      StateValidationError,
    );
  });

  it("rejects dangling approved evidence", () => {
    expect(() => parseProjectState(source.replace("evidence: [H1]", "evidence: [MISSING]"))).toThrow(
      /unknown evidence MISSING/,
    );
  });

  it("rejects approved records without direct human authority", () => {
    const invalid = source.replace("evidence: [A1, H6]", "evidence: [A1]");
    expect(() => parseProjectState(invalid)).toThrow(/need direct human evidence/);
  });

  it("rejects empty explicit selections", () => {
    const invalid = source.replace(
      "selections:\n      dlq_shape: new_status_and_reason_column\n      dlq_trigger: all_failures\n      retry_semantics: terminal_no_retry\n      author_config_location: env_only",
      "selections: {}",
    );
    expect(() => parseProjectState(invalid)).toThrow(/needs a quote or selections/);
  });

  it("rejects unsupported YAML tags", () => {
    expect(() => parseProjectState(source.replace('schema_version: "0.1"', 'schema_version: !future "0.1"'))).toThrow(
      StateValidationError,
    );
  });

  it("rejects unreachable evidence", () => {
    const invalid = source.replace(
      "evidence:\n  H1:",
      "evidence:\n  UNUSED:\n    actor: agent\n    type: proposal\n    source_ref: msg_unused\n    summary: Unreachable proposal.\n\n  H1:",
    );
    expect(() => parseProjectState(invalid)).toThrow(/evidence.UNUSED: evidence is not used/);
  });
});
