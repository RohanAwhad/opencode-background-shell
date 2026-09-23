import { pathToFileURL } from "node:url";
import {
  countProjectState,
  parseProjectState,
} from "../src/project-state";
import { readTextFile } from "./state-file";

export function summarizeState(source: string): string {
  const state = parseProjectState(source);
  const counts = countProjectState(state);
  return `valid: ${counts.intents} intents, ${counts.decisions} decisions, ${counts.instructions} instructions, ${counts.research} research, ${counts.assumptions} assumptions, ${counts.observations} observations, ${counts.unapprovedActions} unapproved actions, ${counts.evidence} evidence, ${counts.openQuestions} open questions`;
}

function runCli(): void {
  const yamlPath = process.argv[2] ?? "example-state.yaml";
  try {
    console.log(summarizeState(readTextFile(yamlPath)));
  } catch (error) {
    console.error(`invalid: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  runCli();
}
