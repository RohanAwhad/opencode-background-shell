import "@fontsource/atkinson-hyperlegible/latin-400.css";
import "@fontsource/atkinson-hyperlegible/latin-700.css";
import "@fontsource/barlow-condensed/latin-600.css";
import "@fontsource/barlow-condensed/latin-700.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import source from "../state.yaml?raw";
import {
  contextForIntent,
  DEPTHS,
  evidenceForIntent,
  filterIntents,
  type DetailDepth,
} from "./dashboard";
import {
  buildProjectIndex,
  countProjectState,
  parseProjectState,
  type ApprovedRecord,
  type ContextKind,
  type ContextRecord,
  type Evidence,
  type Intent,
  type IntentLifecycle,
  type IntentScope,
} from "./project-state";
import "./styles.css";

const state = parseProjectState(source);
const index = buildProjectIndex(state);
const counts = countProjectState(state);

function requiredElement<ElementType extends Element>(selector: string): ElementType {
  const element = document.querySelector<ElementType>(selector);
  if (element === null) {
    throw new Error(`Mission control shell is missing ${selector}`);
  }
  return element;
}

const root = requiredElement<HTMLDivElement>("#app");
const evidenceDialog = requiredElement<HTMLDialogElement>("#evidence-dialog");
const evidenceContent = requiredElement<HTMLDivElement>("#evidence-content");

const CONTEXT_KINDS: readonly ContextKind[] = [
  "research",
  "assumption",
  "observation",
  "unapproved_action",
];

interface UiState {
  depth: DetailDepth;
  scope: IntentScope | "all";
  lifecycle: IntentLifecycle | "all";
  query: string;
  selectedIntentId: string | null;
  contextKinds: Set<ContextKind>;
}

function initialHashState(): Pick<UiState, "depth" | "selectedIntentId"> {
  const params = new URLSearchParams(window.location.hash.slice(1));
  const depth = params.get("depth");
  const intent = params.get("intent");
  return {
    depth: DEPTHS.includes(depth as DetailDepth) ? (depth as DetailDepth) : "summary",
    selectedIntentId: intent !== null && index.intentById.has(intent) ? intent : null,
  };
}

const hashState = initialHashState();
const mobileViewport = window.matchMedia("(max-width: 720px)");
const ui: UiState = {
  ...hashState,
  scope: "all",
  lifecycle: "all",
  query: "",
  contextKinds: new Set(CONTEXT_KINDS),
};

function escapeHtml(value: string): string {
  const replacements: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  };
  return value.replace(/[&<>"']/g, (character) => replacements[character] ?? character);
}

function label(value: string): string {
  return value.replaceAll("_", " ").toLocaleUpperCase();
}

function syncHash(): void {
  const params = new URLSearchParams();
  if (ui.selectedIntentId !== null) {
    params.set("intent", ui.selectedIntentId);
  }
  if (ui.depth !== "summary") {
    params.set("depth", ui.depth);
  }
  const hash = params.toString();
  history.replaceState(null, "", `${window.location.pathname}${window.location.search}${hash ? `#${hash}` : ""}`);
}

function lifecycleMarkup(lifecycle: IntentLifecycle): string {
  return `<span class="status status--${lifecycle}">${escapeHtml(label(lifecycle))}</span>`;
}

function evidenceButton(evidenceId: string, className: string): string {
  const evidence = state.evidence[evidenceId];
  if (evidence === undefined) {
    throw new Error(`Unknown evidence ${evidenceId}`);
  }
  return `<button class="${className} ${className}--${evidence.actor}" data-evidence="${escapeHtml(evidenceId)}">
    <span>${escapeHtml(evidenceId)}</span><small>${escapeHtml(label(evidence.actor))}</small>
  </button>`;
}

function evidenceTokens(record: ApprovedRecord): string {
  if (ui.depth !== "provenance") {
    return "";
  }
  return `<div class="evidence-tokens" aria-label="Authorization evidence">
    ${record.evidence.map((evidenceId) => evidenceButton(evidenceId, "evidence-token")).join("")}
  </div>`;
}

function approvedChildren(title: string, records: readonly ApprovedRecord[]): string {
  if (records.length === 0) {
    return "";
  }
  return `<section class="approved-section">
    <h4>${escapeHtml(title)}</h4>
    <ol>
      ${records
        .map(
          (record) => `<li>
            <div class="record-id">${escapeHtml(record.id)}</div>
            <p>${escapeHtml(record.statement)}</p>
            ${evidenceTokens(record)}
          </li>`,
        )
        .join("")}
    </ol>
  </section>`;
}

function contextCensus(intent: Intent): string {
  const linked = index.contextByIntentId.get(intent.id) ?? [];
  const tally = CONTEXT_KINDS.map((kind) => ({
    kind,
    count: linked.filter((record) => record.kind === kind).length,
  })).filter(({ count }) => count > 0);

  return `<div class="context-census" aria-label="Linked agent context">
    ${tally
      .map(
        ({ kind, count }) =>
          `<span><span class="context-marker context-marker--${kind}" aria-hidden="true"></span>${count} ${escapeHtml(label(kind))}</span>`,
      )
      .join("")}
  </div>`;
}

function renderIntent(intent: Intent, position: number): string {
  const selected = ui.selectedIntentId === intent.id;
  const showApproved = ui.depth !== "summary";
  const titleId = `intent-title-${intent.id}`;
  const mobileContext =
    selected && mobileViewport.matches
      ? `<section class="mobile-context-panel" aria-label="Derived context for ${escapeHtml(intent.id)}">
          <div class="mobile-context-heading"><span>PLANE B</span><strong>DERIVED CONTEXT</strong></div>
          ${selectedContext(intent)}
          ${evidenceRegister(intent)}
        </section>`
      : "";
  return `<article class="intent-row${selected ? " intent-row--selected" : ""}" id="${escapeHtml(intent.id)}" aria-labelledby="${escapeHtml(titleId)}">
    <div class="intent-coordinate" aria-hidden="true">${String(position + 1).padStart(2, "0")}</div>
    <div class="intent-body">
      <div class="intent-heading">
        <div>
          <span class="authority-label">HUMAN AUTHORIZED</span>
          <span class="record-id">${escapeHtml(intent.id)}</span>
        </div>
        ${lifecycleMarkup(intent.lifecycle)}
      </div>
      <h3 class="intent-title" id="${escapeHtml(titleId)}">
        <button id="intent-control-${escapeHtml(intent.id)}" class="intent-select" data-intent="${escapeHtml(intent.id)}" aria-expanded="${selected}">
          <span>${escapeHtml(intent.statement)}</span>
          <span class="select-cue">${selected ? "CLEAR FOCUS" : "FOCUS INTENT"}</span>
        </button>
      </h3>
      <div class="intent-meta">
        <span>SCOPE / ${escapeHtml(label(intent.scope))}</span>
        <span>${(intent.decisions?.length ?? 0) + (intent.instructions?.length ?? 0)} COMMITMENTS</span>
      </div>
      ${contextCensus(intent)}
      ${
        showApproved
          ? `<div class="approved-children">
              ${approvedChildren("Decisions", intent.decisions ?? [])}
              ${approvedChildren("Instructions", intent.instructions ?? [])}
            </div>`
          : ""
      }
      ${evidenceTokens(intent)}
      ${mobileContext}
    </div>
  </article>`;
}

function contextDetail(record: ContextRecord): string {
  if (record.kind === "research") {
    return `<dl><div><dt>Basis</dt><dd>${escapeHtml(label(record.basis))}</dd></div></dl>`;
  }
  if (record.kind === "assumption") {
    return `<dl>
      <div><dt>Status</dt><dd>${escapeHtml(label(record.status))}</dd></div>
      <div><dt>Consequence</dt><dd>${escapeHtml(record.consequence)}</dd></div>
    </dl>`;
  }
  return "";
}

function contextSource(record: ContextRecord): string {
  if (ui.depth !== "provenance" || record.kind === "assumption") {
    return "";
  }
  return `<div class="source-ref">SOURCE / <code>${escapeHtml(record.source_ref)}</code></div>`;
}

function renderContextRecord(record: ContextRecord): string {
  const titleId = `context-title-${record.id}`;
  return `<article class="context-record context-record--${record.kind}" aria-labelledby="${escapeHtml(titleId)}">
    <header>
      <span class="context-marker context-marker--${record.kind}" aria-hidden="true"></span>
      <span>${escapeHtml(label(record.kind))}</span>
      <code>${escapeHtml(record.id)}</code>
    </header>
    <h3 id="${escapeHtml(titleId)}">${escapeHtml(record.statement)}</h3>
    ${contextDetail(record)}
    ${contextSource(record)}
  </article>`;
}

function selectedContext(intent: Intent): string {
  if (ui.depth === "summary" || ui.depth === "decisions") {
    return `<div class="context-locked">
      <span>DEPTH ${ui.depth === "summary" ? "01" : "02"}</span>
      <p>Advance to Context to reveal agent-derived records linked to this intent.</p>
      <button data-depth="context">REVEAL CONTEXT</button>
    </div>`;
  }

  const records = contextForIntent(index, intent.id, ui.contextKinds);
  return `<div class="context-list">
    ${
      records.length > 0
        ? records.map(renderContextRecord).join("")
        : `<p class="empty-copy">No visible context channels are linked to this intent.</p>`
    }
  </div>`;
}

function evidenceRegister(intent: Intent): string {
  if (ui.depth !== "provenance") {
    return "";
  }
  const ids = evidenceForIntent(state, intent);
  return `<section class="evidence-register">
    <div class="section-label">AUTHORIZATION CHAIN</div>
    <div class="evidence-chain">
      ${ids
        .map(
          (evidenceId, itemIndex) =>
            `${itemIndex > 0 ? '<span aria-hidden="true">TO</span>' : ""}${evidenceButton(evidenceId, "evidence-chain-token")}`,
        )
        .join("")}
      <span aria-hidden="true">TO</span><strong>${escapeHtml(intent.id)}</strong>
    </div>
  </section>`;
}

function contextOverview(): string {
  const totals: Array<[ContextKind, number]> = [
    ["research", counts.research],
    ["assumption", counts.assumptions],
    ["observation", counts.observations],
    ["unapproved_action", counts.unapprovedActions],
  ];
  return `<div class="context-overview">
    <div class="section-label">AGENT CONTEXT CENSUS</div>
    <p>Select an intent coordinate to inspect only the context explicitly linked to it.</p>
    <div class="census-grid">
      ${totals
        .map(
          ([kind, count]) => `<div>
            <span class="context-marker context-marker--${kind}" aria-hidden="true"></span>
            <strong>${count}</strong>
            <span>${escapeHtml(label(kind))}</span>
          </div>`,
        )
        .join("")}
    </div>
    <div class="boundary-note">
      <strong>AUTHORITY BOUNDARY</strong>
      <p>These records describe what the agent found, inferred, observed, or changed. They are not human approval.</p>
    </div>
  </div>`;
}

function renderContextBay(selectedIntent: Intent | undefined): string {
  if (selectedIntent !== undefined && mobileViewport.matches) {
    return '<aside class="context-bay context-bay--mobile-hidden" aria-hidden="true"></aside>';
  }
  return `<aside class="context-bay${selectedIntent === undefined ? "" : " context-bay--focused"}" aria-label="Agent-derived context">
    <div class="plane-heading">
      <span>PLANE B</span>
      <h2>Derived Context</h2>
      <span class="agent-label">AGENT DERIVED</span>
    </div>
    ${
      selectedIntent === undefined
        ? contextOverview()
        : `<div class="focused-context">
            <button id="show-all-intents" class="back-to-overview" data-clear-intent>SHOW ALL INTENTS</button>
            <div class="focused-title">
              <span class="record-id">${escapeHtml(selectedIntent.id)}</span>
              <h3>${escapeHtml(selectedIntent.statement)}</h3>
            </div>
            ${selectedContext(selectedIntent)}
            ${evidenceRegister(selectedIntent)}
          </div>`
    }
  </aside>`;
}

function option(value: string, current: string, copy: string): string {
  return `<option value="${escapeHtml(value)}"${value === current ? " selected" : ""}>${escapeHtml(copy)}</option>`;
}

function renderControls(visibleCount: number): string {
  return `<aside class="control-rail" aria-label="View controls">
    <div class="plane-heading">
      <span>CONTROL</span>
      <h2>Disclosure</h2>
    </div>
    <fieldset class="depth-control">
      <legend>Detail depth</legend>
      ${DEPTHS.map(
        (depth, depthIndex) => `<button id="depth-${depth}" data-depth="${depth}" aria-pressed="${ui.depth === depth}">
          <span>0${depthIndex + 1}</span>${escapeHtml(label(depth))}
        </button>`,
      ).join("")}
    </fieldset>
    <label class="search-control" for="intent-search">
      <span>Search all recorded text</span>
      <input id="intent-search" type="search" value="${escapeHtml(ui.query)}" placeholder="ID, phrase, source..." autocomplete="off" />
    </label>
    <div class="select-grid">
      <label for="scope-filter">Scope
        <select id="scope-filter">
          ${option("all", ui.scope, "All scopes")}
          ${option("project", ui.scope, "Project")}
          ${option("session_workflow", ui.scope, "Session workflow")}
          ${option("one_shot_operation", ui.scope, "One-shot operation")}
        </select>
      </label>
      <label for="lifecycle-filter">Lifecycle
        <select id="lifecycle-filter">
          ${option("all", ui.lifecycle, "All states")}
          ${option("active", ui.lifecycle, "Active")}
          ${option("completed", ui.lifecycle, "Completed")}
          ${option("running_at_capture", ui.lifecycle, "Running at capture")}
        </select>
      </label>
    </div>
    <fieldset class="channel-control">
      <legend>Context channels</legend>
      ${CONTEXT_KINDS.map(
        (kind) => `<label>
          <input id="channel-${kind}" type="checkbox" data-context-kind="${kind}"${ui.contextKinds.has(kind) ? " checked" : ""} />
          <span class="context-marker context-marker--${kind}" aria-hidden="true"></span>
          ${escapeHtml(label(kind))}
        </label>`,
      ).join("")}
    </fieldset>
    <div class="result-readout" role="status" aria-live="polite">
      <strong>${visibleCount} / ${counts.intents}</strong>
      <span>INTENTS IN VIEW</span>
    </div>
    <button id="reset-view" class="reset-button" data-reset>RESET VIEW</button>
  </aside>`;
}

function renderSignals(): string {
  const runningIntents = state.human_approved.intents.filter(
    (intent) => intent.lifecycle === "running_at_capture",
  );
  const actionIntentIds = [
    ...new Set(state.agent_context.unapproved_actions.flatMap((record) => record.intent_ids)),
  ];
  const signals: string[] = [];

  if (runningIntents.length > 0) {
    const ids = runningIntents.map((intent) => intent.id);
    signals.push(`<button data-signal-intent="${escapeHtml(ids[0]!)}">
      <span class="signal-index">${String(signals.length + 1).padStart(2, "0")}</span>
      <span><strong>${runningIntents.length} RUNNING AT CAPTURE</strong> ${escapeHtml(ids.join(", "))} ${runningIntents.length === 1 ? "was" : "were"} not asserted as live.</span>
    </button>`);
  }

  if (actionIntentIds.length > 0) {
    signals.push(`<button class="signal-alert" data-signal-intent="${escapeHtml(actionIntentIds[0]!)}">
      <span class="signal-index">${String(signals.length + 1).padStart(2, "0")}</span>
      <span><strong>${counts.unapprovedActions} UNAPPROVED ACTIONS</strong> linked to ${escapeHtml(actionIntentIds.join(", "))}.</span>
    </button>`);
  }

  return `<section class="signal-strip" aria-label="Snapshot signals">
    ${signals.join("")}
    <div class="snapshot-warning">SNAPSHOT, NOT LIVE TELEMETRY</div>
  </section>`;
}

interface RenderOptions {
  focusId?: string;
  preserveSearchFocus?: boolean;
}

function renderApp(options: RenderOptions = {}): void {
  const search = document.querySelector<HTMLInputElement>("#intent-search");
  const selectionStart = options.preserveSearchFocus ? search?.selectionStart : null;
  const visibleIntents = filterIntents(state, index, {
    query: ui.query,
    scope: ui.scope,
    lifecycle: ui.lifecycle,
  });

  if (
    ui.selectedIntentId !== null &&
    !visibleIntents.some((intent) => intent.id === ui.selectedIntentId)
  ) {
    ui.selectedIntentId = null;
    syncHash();
  }
  const selectedIntent =
    ui.selectedIntentId === null ? undefined : index.intentById.get(ui.selectedIntentId);

  root.innerHTML = `<div class="mission-shell">
    <header class="masthead">
      <div class="brand-block">
        <span class="brand-mark">H/A</span>
        <div>
          <span class="kicker">HUMAN-AGENT INTERACTION</span>
          <h1>Protocol Deck</h1>
        </div>
      </div>
      <div class="mission-title">
        <span>MISSION CONTROL / 01</span>
        <strong>${escapeHtml(state.project.id)}</strong>
      </div>
    </header>

    <section class="capture-tape" aria-label="Snapshot metadata">
      <div><span>SCHEMA</span><strong>${escapeHtml(state.schema_version)}</strong></div>
      <div><span>SOURCE SESSION</span><code>${escapeHtml(state.snapshot.source_session)}</code></div>
      <div><span>CAPTURED THROUGH</span><code>${escapeHtml(state.snapshot.captured_through)}</code></div>
      <div><span>HISTORY</span><strong>${escapeHtml(label(state.snapshot.historical_source))}</strong></div>
    </section>

    ${renderSignals()}

    <div class="workspace">
      ${renderControls(visibleIntents.length)}
      <main class="authority-ledger">
        <div class="plane-heading">
          <span>PLANE A</span>
          <h2>Authorized Plan</h2>
          <span class="authority-label">HUMAN AUTHORIZED</span>
        </div>
        <div class="ledger-summary">
          <div><strong>${counts.intents}</strong><span>INTENTS</span></div>
          <div><strong>${counts.decisions}</strong><span>DECISIONS</span></div>
          <div><strong>${counts.instructions}</strong><span>INSTRUCTIONS</span></div>
          <div><strong>${counts.evidence}</strong><span>EVIDENCE ITEMS</span></div>
        </div>
        <div class="intent-ledger">
          ${
            visibleIntents.length > 0
              ? visibleIntents.map(renderIntent).join("")
              : `<div class="no-results"><strong>NO MATCHING INTENT</strong><p>Reset the view or broaden the current query.</p></div>`
          }
        </div>
      </main>
      ${renderContextBay(selectedIntent)}
    </div>

    <footer class="mission-footer">
      <span>OPEN QUESTIONS / ${counts.openQuestions}</span>
      <span>${escapeHtml(state.snapshot.semantics.replaceAll("_", " "))}</span>
      <span>SUPERSEDED ENTRIES / ${escapeHtml(label(state.snapshot.superseded_entries))}</span>
    </footer>
  </div>`;

  if (options.preserveSearchFocus) {
    const nextSearch = document.querySelector<HTMLInputElement>("#intent-search");
    nextSearch?.focus();
    if (selectionStart !== null && selectionStart !== undefined) {
      nextSearch?.setSelectionRange(selectionStart, selectionStart);
    }
  } else if (options.focusId !== undefined) {
    document.getElementById(options.focusId)?.focus();
  }
}

function renderEvidence(evidenceId: string): void {
  const evidence = state.evidence[evidenceId];
  if (evidence === undefined) {
    throw new Error(`Unknown evidence ${evidenceId}`);
  }

  let body = "";
  if (evidence.type === "direct_instruction") {
    body = `<blockquote>${escapeHtml(evidence.quote)}</blockquote>`;
  } else if (evidence.type === "proposal") {
    body = `<p class="proposal-copy">${escapeHtml(evidence.summary)}</p>`;
  } else {
    const selections = Object.entries(evidence.selections ?? {});
    body = `${
      evidence.quote === undefined ? "" : `<blockquote>${escapeHtml(evidence.quote)}</blockquote>`
    }
      ${
        selections.length === 0
          ? ""
          : `<dl class="selection-list">${selections
              .map(
                ([key, value]) =>
                  `<div><dt><code>${escapeHtml(key)}</code></dt><dd><code>${escapeHtml(value)}</code></dd></div>`,
              )
              .join("")}</dl>`
      }
      ${
        evidence.proposal_ref === undefined
          ? ""
          : `<div class="proposal-link">AUTHORIZES PROPOSAL <button data-evidence="${escapeHtml(evidence.proposal_ref)}">${escapeHtml(evidence.proposal_ref)}</button></div>`
      }`;
  }

  evidenceContent.innerHTML = `<div class="dialog-heading dialog-heading--${evidence.actor}">
    <div>
      <span>${escapeHtml(label(evidence.actor))} / ${escapeHtml(label(evidence.type))}</span>
      <h2 id="evidence-title" tabindex="-1">Evidence ${escapeHtml(evidenceId)}</h2>
    </div>
    <button class="dialog-close" data-close-dialog aria-label="Close evidence">CLOSE</button>
  </div>
  <div class="dialog-body">
    ${body}
    <div class="source-ref">SOURCE / <code>${escapeHtml(evidence.source_ref)}</code></div>
  </div>`;
  if (!evidenceDialog.open) {
    evidenceDialog.showModal();
  }
  evidenceContent.querySelector<HTMLElement>("#evidence-title")?.focus();
}

let evidenceOpener: HTMLElement | null = null;

root.addEventListener("click", (event) => {
  const target = event.target as HTMLElement;
  const depthButton = target.closest<HTMLButtonElement>("[data-depth]");
  if (depthButton?.dataset.depth !== undefined) {
    ui.depth = depthButton.dataset.depth as DetailDepth;
    syncHash();
    renderApp({ focusId: `depth-${ui.depth}` });
    return;
  }

  const signalButton = target.closest<HTMLButtonElement>("[data-signal-intent]");
  if (signalButton?.dataset.signalIntent !== undefined) {
    ui.scope = "all";
    ui.lifecycle = "all";
    ui.query = "";
    ui.selectedIntentId = signalButton.dataset.signalIntent;
    syncHash();
    renderApp({ focusId: `intent-control-${ui.selectedIntentId}` });
    return;
  }

  const intentButton = target.closest<HTMLButtonElement>("[data-intent]");
  if (intentButton?.dataset.intent !== undefined) {
    ui.selectedIntentId =
      ui.selectedIntentId === intentButton.dataset.intent ? null : intentButton.dataset.intent;
    syncHash();
    renderApp({ focusId: `intent-control-${intentButton.dataset.intent}` });
    return;
  }

  if (target.closest("[data-clear-intent]") !== null) {
    const previousIntentId = ui.selectedIntentId;
    ui.selectedIntentId = null;
    syncHash();
    renderApp({
      focusId:
        previousIntentId === null ? "reset-view" : `intent-control-${previousIntentId}`,
    });
    return;
  }

  const evidenceButton = target.closest<HTMLButtonElement>("[data-evidence]");
  if (evidenceButton?.dataset.evidence !== undefined) {
    evidenceOpener = evidenceButton;
    renderEvidence(evidenceButton.dataset.evidence);
    return;
  }

  if (target.closest("[data-reset]") !== null) {
    ui.depth = "summary";
    ui.scope = "all";
    ui.lifecycle = "all";
    ui.query = "";
    ui.selectedIntentId = null;
    ui.contextKinds = new Set(CONTEXT_KINDS);
    syncHash();
    renderApp({ focusId: "reset-view" });
  }
});

root.addEventListener("input", (event) => {
  const target = event.target;
  if (target instanceof HTMLInputElement && target.id === "intent-search") {
    ui.query = target.value;
    renderApp({ preserveSearchFocus: true });
  }
});

root.addEventListener("change", (event) => {
  const target = event.target;
  if (target instanceof HTMLSelectElement && target.id === "scope-filter") {
    ui.scope = target.value as UiState["scope"];
    renderApp({ focusId: "scope-filter" });
    return;
  }
  if (target instanceof HTMLSelectElement && target.id === "lifecycle-filter") {
    ui.lifecycle = target.value as UiState["lifecycle"];
    renderApp({ focusId: "lifecycle-filter" });
    return;
  }
  if (target instanceof HTMLInputElement && target.dataset.contextKind !== undefined) {
    const kind = target.dataset.contextKind as ContextKind;
    if (target.checked) {
      ui.contextKinds.add(kind);
    } else {
      ui.contextKinds.delete(kind);
    }
    renderApp({ focusId: `channel-${kind}` });
  }
});

evidenceDialog.addEventListener("click", (event) => {
  const target = event.target as HTMLElement;
  if (target.closest("[data-close-dialog]") !== null) {
    evidenceDialog.close();
    return;
  }
  const evidenceButton = target.closest<HTMLButtonElement>("[data-evidence]");
  if (evidenceButton?.dataset.evidence !== undefined) {
    renderEvidence(evidenceButton.dataset.evidence);
  }
});

evidenceDialog.addEventListener("close", () => {
  if (evidenceOpener?.isConnected) {
    evidenceOpener.focus();
  }
  evidenceOpener = null;
});

window.addEventListener("hashchange", () => {
  const next = initialHashState();
  ui.depth = next.depth;
  ui.selectedIntentId = next.selectedIntentId;
  renderApp();
});

mobileViewport.addEventListener("change", () => renderApp());

renderApp();
