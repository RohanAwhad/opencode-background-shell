import { describe, expect, it } from "vitest";
import source from "../example-state.yaml?raw";
import { contextForIntent, evidenceForIntent, filterIntents } from "./dashboard";
import { buildProjectIndex, parseProjectState } from "./project-state";

const state = parseProjectState(source);
const index = buildProjectIndex(state);

describe("dashboard selectors", () => {
  it("filters durable active project intent", () => {
    const intents = filterIntents(state, index, {
      query: "",
      scope: "project",
      lifecycle: "active",
    });
    expect(intents.map((intent) => intent.id)).toEqual(["INT-001", "INT-002"]);
  });

  it.each([
    ["terminal_no_retry", ["INT-001", "INT-002"]],
    ["cr-akashgit", ["INT-004"]],
    ["code_path_inspection", ["INT-002"]],
    ["ABHI1092 pull", ["INT-001", "INT-002", "INT-004"]],
    ["H1", ["INT-001", "INT-002"]],
  ])("searches linked records and evidence for %s", (query, expected) => {
    const intents = filterIntents(state, index, {
      query,
      scope: "all",
      lifecycle: "all",
    });
    expect(intents.map((intent) => intent.id)).toEqual(expected);
  });

  it("filters linked context without changing source order", () => {
    const visibleKinds = new Set(["research", "assumption"] as const);
    expect(contextForIntent(index, "INT-002", visibleKinds).map((record) => record.id)).toEqual([
      "RES-003",
      "RES-004",
      "ASM-001",
      "ASM-002",
    ]);
  });

  it("resolves proposal evidence once in declared order", () => {
    const intent = index.intentById.get("INT-004");
    expect(intent).toBeDefined();
    expect(evidenceForIntent(state, intent!)).toEqual(["A1", "H6"]);
  });

  it("places a proposal before a selection that is its only direct reference", () => {
    const intent = index.intentById.get("INT-004");
    expect(intent).toBeDefined();
    expect(evidenceForIntent(state, { ...intent!, evidence: ["H6"] })).toEqual(["A1", "H6"]);
  });
});
