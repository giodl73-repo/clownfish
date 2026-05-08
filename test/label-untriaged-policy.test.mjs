import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateJob, renderPrompt } from "../scripts/lib.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

// ----------------------------------------------------------------
// Schema sanity
// ----------------------------------------------------------------

test("triage_policy enum includes label_untriaged", () => {
  const schemaPath = path.join(repoRoot, "schemas", "job.schema.json");
  const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
  const enumValues = schema.properties.triage_policy.enum;
  assert.ok(Array.isArray(enumValues));
  assert.ok(enumValues.includes("label_untriaged"));
  assert.ok(enumValues.includes("low_signal_prs"));
});

test("schema declares proposed_label and proposed_label_evidence", () => {
  const schemaPath = path.join(repoRoot, "schemas", "job.schema.json");
  const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
  assert.ok(schema.properties.proposed_label);
  assert.equal(schema.properties.proposed_label.type, "string");
  assert.ok(schema.properties.proposed_label_evidence);
});

// ----------------------------------------------------------------
// validateJob — label_untriaged invariants
// ----------------------------------------------------------------

function makeBaseJob(overrides = {}) {
  return {
    raw: "---\n---\n",
    frontmatter: {
      repo: "openclaw/openclaw",
      cluster_id: "label_untriaged-gateway-2026-05-08",
      mode: "plan",
      allowed_actions: ["label"],
      candidates: ["#79443", "#79412", "#79376"],
      triage_policy: "label_untriaged",
      proposed_label: "gateway",
      security_policy: "central_security_only",
      security_sensitive: false,
      ...overrides,
    },
  };
}

test("validateJob accepts a well-formed label_untriaged job", () => {
  const job = makeBaseJob();
  assert.deepEqual(validateJob(job), []);
});

test("validateJob rejects label_untriaged without proposed_label", () => {
  const job = makeBaseJob({ proposed_label: undefined });
  const errors = validateJob(job);
  assert.ok(
    errors.some((e) => e.includes("proposed_label")),
    `expected proposed_label error; got ${JSON.stringify(errors)}`,
  );
});

test("validateJob rejects label_untriaged with empty proposed_label", () => {
  const job = makeBaseJob({ proposed_label: "" });
  const errors = validateJob(job);
  assert.ok(errors.some((e) => e.includes("proposed_label")));
});

test("validateJob rejects label_untriaged with mode=execute and no allow_label_apply", () => {
  const job = makeBaseJob({ mode: "execute" });
  const errors = validateJob(job);
  assert.ok(
    errors.some((e) => e.includes("allow_label_apply")),
    `expected allow_label_apply error; got ${JSON.stringify(errors)}`,
  );
});

test("validateJob rejects label_untriaged with mode=autonomous and no allow_label_apply", () => {
  const job = makeBaseJob({ mode: "autonomous" });
  const errors = validateJob(job);
  assert.ok(errors.some((e) => e.includes("allow_label_apply")));
});

test("validateJob accepts label_untriaged with mode=execute and allow_label_apply=true", () => {
  const job = makeBaseJob({ mode: "execute", allow_label_apply: true });
  assert.deepEqual(validateJob(job), []);
});

test("validateJob accepts label_untriaged with mode=autonomous and allow_label_apply=true", () => {
  const job = makeBaseJob({ mode: "autonomous", allow_label_apply: true });
  assert.deepEqual(validateJob(job), []);
});

test("validateJob rejects label_untriaged with non-label allowed_actions", () => {
  const job = makeBaseJob({ allowed_actions: ["label", "close"] });
  const errors = validateJob(job);
  assert.ok(
    errors.some((e) => e.includes("only allows the 'label' action")),
    `expected close-rejection error; got ${JSON.stringify(errors)}`,
  );
});

test("validateJob rejects label_untriaged with comment/merge in allowed_actions", () => {
  for (const action of ["comment", "merge", "fix", "raise_pr"]) {
    const job = makeBaseJob({ allowed_actions: [action] });
    const errors = validateJob(job);
    assert.ok(
      errors.some((e) => e.includes("only allows the 'label' action")),
      `expected rejection of ${action}; got ${JSON.stringify(errors)}`,
    );
  }
});

// ----------------------------------------------------------------
// renderPrompt — instructions get loaded for label_untriaged jobs
// ----------------------------------------------------------------

test("renderPrompt loads instructions/label-untriaged.md for label_untriaged jobs", () => {
  const job = makeBaseJob();
  const prompt = renderPrompt(job, "plan");
  assert.match(
    prompt,
    /Triage Policy: `label_untriaged`/,
    "renderPrompt did not include the label-untriaged instruction file",
  );
  assert.match(
    prompt,
    /Bias toward `needs_human`/i,
    "renderPrompt did not include the conservative-bias guidance",
  );
});

test("renderPrompt does NOT load label-untriaged instructions for non-label_untriaged jobs", () => {
  const job = makeBaseJob({ triage_policy: "low_signal_prs", proposed_label: undefined, allowed_actions: ["close", "comment"] });
  const prompt = renderPrompt(job, "plan");
  assert.doesNotMatch(prompt, /Triage Policy: `label_untriaged`/);
});

// ----------------------------------------------------------------
// Discovery script source-level invariants
// ----------------------------------------------------------------

test("discovery script imports only existing lib helpers", () => {
  const scriptPath = path.join(repoRoot, "scripts", "import-gitcrawl-untriaged.mjs");
  const source = fs.readFileSync(scriptPath, "utf8");
  const importLine = source.match(/^import\s+\{([^}]+)\}\s+from\s+"\.\/lib\.mjs";/m);
  assert.ok(importLine);
  const imports = importLine[1].split(",").map((s) => s.trim()).filter(Boolean);
  const libSource = fs.readFileSync(path.join(repoRoot, "scripts", "lib.mjs"), "utf8");
  for (const imp of imports) {
    assert.ok(
      libSource.includes(`export function ${imp}`) || libSource.includes(`export const ${imp}`),
      `lib.mjs does not export ${imp}`,
    );
  }
});

test("discovery script declares the documented safety filters", () => {
  const scriptPath = path.join(repoRoot, "scripts", "import-gitcrawl-untriaged.mjs");
  const source = fs.readFileSync(scriptPath, "utf8");
  assert.match(source, /hasSecuritySignalText/);
  assert.match(source, /isProductFeatureRequest/);
  assert.match(source, /repoLabels\.has\(label\)/);
  assert.match(source, /skip-existing/);
  assert.match(source, /min-untriaged/);
});

test("discovery script hard-blocks mode != plan", () => {
  const scriptPath = path.join(repoRoot, "scripts", "import-gitcrawl-untriaged.mjs");
  const source = fs.readFileSync(scriptPath, "utf8");
  assert.match(
    source,
    /label_untriaged v1 is plan-only/,
    "discovery script does not hard-block mode != plan",
  );
});

test("discovery script uses TITLE-only token match", () => {
  const scriptPath = path.join(repoRoot, "scripts", "import-gitcrawl-untriaged.mjs");
  const source = fs.readFileSync(scriptPath, "utf8");
  // `inferAreas` must operate on title only, not title+body
  assert.match(
    source,
    /String\(issue\.title \?\? ""\)\.toLowerCase\(\)/,
    "inferAreas should match against title only, not body",
  );
  assert.doesNotMatch(
    source,
    /\$\{issue\.title\}\s+\$\{issue\.body\}/,
    "inferAreas must not concatenate title+body for matching",
  );
});

test("discovery script records primary.tokens for evidence trail", () => {
  const scriptPath = path.join(repoRoot, "scripts", "import-gitcrawl-untriaged.mjs");
  const source = fs.readFileSync(scriptPath, "utf8");
  assert.match(
    source,
    /tokens:\s*primary\.tokens/,
    "evidenceByNumber must record the routed primary's tokens, not matches[0]",
  );
});

test("discovery script implements member-overlap skip across days", () => {
  const scriptPath = path.join(repoRoot, "scripts", "import-gitcrawl-untriaged.mjs");
  const source = fs.readFileSync(scriptPath, "utf8");
  assert.match(source, /existingMemberRefs\.has\(c\.number\)/);
  assert.match(source, /scanExistingLabelUntriaged/);
});

test("discovery script blocks metadata-prefix labels via PROHIBITED_PREFIXES", () => {
  const scriptPath = path.join(repoRoot, "scripts", "import-gitcrawl-untriaged.mjs");
  const source = fs.readFileSync(scriptPath, "utf8");
  // PROHIBITED_PREFIXES must contain priority/severity/kind/type/status/state
  for (const prefix of ["priority:", "severity:", "kind:", "type:", "status:", "state:"]) {
    assert.match(
      source,
      new RegExp(`["']${prefix}["']`),
      `PROHIBITED_PREFIXES must include ${prefix} to block metadata-prefix labels`,
    );
  }
});

test("discovery script wraps top-level execution in import.meta.url guard", () => {
  const scriptPath = path.join(repoRoot, "scripts", "import-gitcrawl-untriaged.mjs");
  const source = fs.readFileSync(scriptPath, "utf8");
  assert.match(
    source,
    /import\.meta\.url/,
    "discovery script must guard top-level execution behind import.meta.url so it's safely importable",
  );
});

test("discovery script accepts --label flag for single-area rollout", () => {
  const scriptPath = path.join(repoRoot, "scripts", "import-gitcrawl-untriaged.mjs");
  const source = fs.readFileSync(scriptPath, "utf8");
  assert.match(
    source,
    /labelFilter\s*=\s*typeof args\.label === "string"/,
    "discovery script must read --label as a string arg",
  );
  assert.match(
    source,
    /areaCandidates\s*=\s*before\.filter\(\(entry\) => entry\.label === labelFilter\)/,
    "discovery must narrow areaCandidates to the single matching label",
  );
  assert.match(
    source,
    /did not match any area candidate/,
    "discovery must exit with a helpful message when --label has no match (typo defense)",
  );
});

test("discovery script blocks bareKey < 4 chars (generic-token defense)", () => {
  const scriptPath = path.join(repoRoot, "scripts", "import-gitcrawl-untriaged.mjs");
  const source = fs.readFileSync(scriptPath, "utf8");
  assert.match(
    source,
    /bareKey\.length\s*<\s*4/,
    "inferAreas must skip bare-key tokens shorter than 4 chars to avoid false-positives like 'web' / 'cli'",
  );
});

// ----------------------------------------------------------------
// Instruction file
// ----------------------------------------------------------------

test("instructions/label-untriaged.md documents the verdict matrix", () => {
  const docPath = path.join(repoRoot, "instructions", "label-untriaged.md");
  const doc = fs.readFileSync(docPath, "utf8");
  assert.match(doc, /^# Triage Policy: `label_untriaged`/m);
  assert.match(doc, /\bapply\b/i);
  assert.match(doc, /\bneeds_human\b/i);
  assert.match(doc, /\breject\b/i);
  assert.match(doc, /Bias toward `needs_human`/i);
  assert.match(doc, /allow_label_apply/);
});

// ----------------------------------------------------------------
// apply-result.mjs — label applicator wiring and safety invariants
// ----------------------------------------------------------------

function applyResultSource() {
  // Normalize CRLF → LF so the function-extraction regexes are line-ending agnostic.
  return fs.readFileSync(path.join(repoRoot, "scripts", "apply-result.mjs"), "utf8").replace(/\r\n/g, "\n");
}

// Cross-applicator invariants: behaviors that apply to close, merge,
// and label actions alike. Pinning these here so the asymmetry can't
// silently drift back when one applicator changes.

test("per-action loop converts thrown errors into structured 'failed' results", () => {
  const source = applyResultSource();
  assert.match(
    source,
    /for \(const action of result\.actions[\s\S]+?try \{[\s\S]+?applyAction\([\s\S]+?\} catch \(error\) \{[\s\S]+?status: "failed"/,
    "per-action loop must wrap applyAction in try/catch so a single non-retryable gh error doesn't abandon the rest of the batch",
  );
});

test("validateLowSignalLiveState bot-filters live.assignees", () => {
  const source = applyResultSource();
  const fn = source.match(/function validateLowSignalLiveState\([\s\S]+?\n\}\n/);
  assert.ok(fn, "validateLowSignalLiveState must exist");
  assert.match(fn[0], /entry\?\.type !== "Bot"/);
  assert.match(fn[0], /humanAssignees\.length > 0/);
});

test("apply-result registers LABEL_ACTIONS and routes them through isApplicatorAction", () => {
  const source = applyResultSource();
  assert.match(source, /const LABEL_ACTIONS = new Set\(\["label"\]\)/);
  assert.match(
    source,
    /LABEL_ACTIONS\.has\(name\)/,
    "isApplicatorAction must include LABEL_ACTIONS so label actions don't get silently skipped",
  );
});

test("apply-result dispatches label actions to applyLabelAction", () => {
  const source = applyResultSource();
  assert.match(
    source,
    /if \(LABEL_ACTIONS\.has\(actionName\)\) \{\s*return applyLabelAction\(/,
    "applyAction dispatcher must route label actions to applyLabelAction",
  );
});

test("applyLabelAction enforces label equality with job.proposed_label", () => {
  const source = applyResultSource();
  assert.match(
    source,
    /requestedLabel !== proposedLabel/,
    "applyLabelAction must reject actions whose label != job.proposed_label",
  );
});

test("applyLabelAction re-checks security signal on live state", () => {
  const source = applyResultSource();
  const fn = source.match(/function applyLabelAction\([\s\S]+?\n\}\n/);
  assert.ok(fn, "applyLabelAction must exist");
  assert.match(fn[0], /hasSecuritySignal\(live\)/);
});

test("applyLabelAction performs target_updated_at drift check", () => {
  const source = applyResultSource();
  const fn = source.match(/function applyLabelAction\([\s\S]+?\n\}\n/);
  assert.ok(fn);
  assert.match(fn[0], /expectedUpdatedAt !== live\.updated_at/);
  assert.match(fn[0], /target changed since worker review/);
});

test("applyLabelAction is idempotent when label is already applied", () => {
  const source = applyResultSource();
  const fn = source.match(/function applyLabelAction\([\s\S]+?\n\}\n/);
  assert.ok(fn);
  assert.match(fn[0], /label already applied/);
});

test("applyLabelAction restricts targets to job.candidates", () => {
  const source = applyResultSource();
  const fn = source.match(/function applyLabelAction\([\s\S]+?\n\}\n/);
  assert.ok(fn);
  assert.match(fn[0], /target is not listed in job candidates/);
});

test("applyLabelAction skips when target is closed", () => {
  const source = applyResultSource();
  const fn = source.match(/function applyLabelAction\([\s\S]+?\n\}\n/);
  assert.ok(fn);
  assert.match(fn[0], /live\.state !== "open"/);
});

test("applyLabelAction blocks when target has been assigned (no longer untriaged)", () => {
  const source = applyResultSource();
  const fn = source.match(/function applyLabelAction\([\s\S]+?\n\}\n/);
  assert.ok(fn);
  assert.match(fn[0], /humanAssignees\.length > 0/);
  assert.match(fn[0], /no longer untriaged/);
});

test("applyLabelAction honors --dry-run before invoking gh", () => {
  const source = applyResultSource();
  const fn = source.match(/function applyLabelAction\([\s\S]+?\n\}\n/);
  assert.ok(fn);
  // The dry-run branch must appear BEFORE the ghWithRetry call that adds the label
  const dryIdx = fn[0].indexOf('"dry run"');
  const ghIdx = fn[0].indexOf("ghWithRetry");
  assert.ok(dryIdx > 0 && ghIdx > 0, "applyLabelAction must reach both dry-run and gh apply branches");
  assert.ok(dryIdx < ghIdx, "dry-run short-circuit must happen before gh issue edit");
});

test("codex-result schema permits action.label so worker can emit label actions in execute mode", () => {
  const schemaPath = path.join(repoRoot, "schemas", "codex-result.schema.json");
  const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
  const actionItem = schema.properties.actions.items;
  assert.equal(actionItem.additionalProperties, false, "actions-item declares additionalProperties: false");
  assert.ok(actionItem.properties.label, "actions-item must declare a 'label' property to permit label-action output");
  assert.deepEqual(actionItem.properties.label.type, ["string", "null"]);
});

test("applyLabelAction blocks PR targets (label apply requires issue)", () => {
  const source = applyResultSource();
  const fn = source.match(/function applyLabelAction\([\s\S]+?\n\}\n/);
  assert.ok(fn);
  assert.match(fn[0], /live\.pull_request/);
  assert.match(fn[0], /requires issue target_kind/);
});

test("applyLabelAction filters bot assignees out of the assignee guard", () => {
  const source = applyResultSource();
  const fn = source.match(/function applyLabelAction\([\s\S]+?\n\}\n/);
  assert.ok(fn);
  assert.match(fn[0], /entry\?\.type !== "Bot"/);
});

test("applyLabelAction converts 'label not found' gh failures into structured blocked", () => {
  const source = applyResultSource();
  const fn = source.match(/function applyLabelAction\([\s\S]+?\n\}\n/);
  assert.ok(fn);
  assert.match(fn[0], /not found\|could not add label/);
  assert.match(fn[0], /no longer exists on repo/);
  // The throw must be re-raised for non-matching errors so unrelated failures aren't swallowed
  assert.match(fn[0], /throw error/);
});

test("validateLabelPolicy gates on triage_policy and allow_label_apply", () => {
  const source = applyResultSource();
  const fn = source.match(/function validateLabelPolicy\([\s\S]+?\n\}\n/);
  assert.ok(fn, "validateLabelPolicy must exist");
  assert.match(fn[0], /triage_policy !== "label_untriaged"/);
  assert.match(fn[0], /allow_label_apply !== true/);
});

// ----------------------------------------------------------------
// Determinism
// ----------------------------------------------------------------

test("slugify is deterministic for repeat runs on the same label", () => {
  const scriptPath = path.join(repoRoot, "scripts", "import-gitcrawl-untriaged.mjs");
  const source = fs.readFileSync(scriptPath, "utf8");
  const slugifyMatch = source.match(/function slugify\([^)]*\)\s*\{[\s\S]+?\n\}/);
  assert.ok(slugifyMatch);
  const fn = slugifyMatch[0];
  assert.ok(!fn.includes("Date.now"));
  assert.ok(!fn.includes("Math.random"));
});
