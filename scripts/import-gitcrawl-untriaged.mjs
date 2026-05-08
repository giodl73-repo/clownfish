#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { hasSecuritySignalText, parseArgs, repoRoot } from "./lib.mjs";

// import-gitcrawl-untriaged.mjs — autonomous discovery for the
// `label_untriaged` triage policy.
//
// Mirrors `import-gitcrawl-clusters.mjs` shape: reads gitcrawl SQLite,
// emits one job per area-cluster of untriaged issues, writes job
// markdown files into `jobs/<owner>/inbox/` for the existing worker
// to pick up.
//
// What's different: groups by INFERRED area-label (title-token-only
// signal — body-only matches are too noisy and excluded; cluster-
// membership cross-check adds confidence) rather than gitcrawl's own
// clusters. Each emitted job carries `triage_policy: label_untriaged`
// and a `proposed_label` for the worker to validate per-candidate.
//
// **Hard scope for v1: plan mode only.** This script writes only
// `mode: plan` jobs. The applicator path for `label` actions in
// `apply-result.mjs` does not exist yet — close-actions and label-
// actions go through different code paths there, and `apply-result.mjs`
// has no `applyLabelAction` implementation. Until that lands, this
// policy is plan-only proposals; a separate follow-up PR adds the
// applicator with proper re-verify-state guards. `validateJob` in
// `lib.mjs` enforces this restriction at job-load time.
//
// Safety inheritance for plan-mode jobs:
//   - skips security-sensitive issues via hasSecuritySignalText
//   - skips feature-request shaped titles
//   - allowlist-bounded (only labels already on the repo)
//   - skip-existing + member-overlap skip avoid duplicate jobs
//   - title-token only (body-only matches dropped to reduce noise)
//   - imports are side-effect-safe via the import.meta.url guard
//
// Usage:
//   node scripts/import-gitcrawl-untriaged.mjs --from-gitcrawl [--limit N]
//                                              [--min-untriaged N] [--since-hours N]
//                                              [--label "channel: discord"]
//                                              [--repo owner/repo] [--db path]
//
// --label scopes discovery to a single area label so an operator can
// roll out one area at a time. The argument must match an existing
// repo label exactly (case-sensitive). Without --label, all area
// labels meeting the population threshold are processed.

const PROHIBITED_PREFIXES = ["size:", "proof:", "triage:", "priority:", "severity:", "kind:", "type:", "status:", "state:"];
const PROHIBITED_LABELS = new Set([
  "bug", "bug:behavior", "regression", "enhancement", "docs", "cli",
  "commands", "scripts", "agents", "maintainer",
]);

const isMain = import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}` ||
               import.meta.url === fileURLToPath(import.meta.url);

let args;
let repo;
let dbPath;
let outDir;
let mode;
let sinceHours;
let minUntriaged;
let minLabelPopulation;
let limit;
let skipExisting;
let skipSecurity;
let skipFeatureRequests;
let labelFilter;

if (isMain) {
  runMain();
}

function runMain() {
  args = parseArgs(process.argv.slice(2));
  repo = String(args.repo ?? "openclaw/openclaw");
  dbPath = path.resolve(String(args.db ?? path.join(os.homedir(), ".config", "gitcrawl", "gitcrawl.db")));
  outDir = path.resolve(String(args.out ?? path.join(repoRoot(), "jobs", repo.split("/")[0], "inbox")));
  mode = String(args.mode ?? "plan");
  sinceHours = numberArg("since-hours", 24);
  minUntriaged = numberArg("min-untriaged", 3);
  minLabelPopulation = numberArg("min-label-population", 5);
  limit = numberArg("limit", 20);
  skipExisting = args["skip-existing"] !== "false";
  skipSecurity = args["include-security"] !== true && args["skip-security"] !== "false";
  skipFeatureRequests = args["include-feature-requests"] !== true && args["skip-feature-requests"] !== "false";
  labelFilter = typeof args.label === "string" ? args.label.trim() : "";

  // V1 hard scope: plan mode only. Until apply-result.mjs has an
  // applyLabelAction with re-verify-state, security re-check, and
  // proposed_label-equality enforcement, label_untriaged proposals
  // are read-only.
  if (mode !== "plan") {
    console.error(
      `label_untriaged v1 is plan-only; --mode ${mode} is not yet supported. ` +
      `The applicator path for label actions is a follow-up PR.`,
    );
    process.exit(2);
  }
  fs.mkdirSync(outDir, { recursive: true });
  runDiscovery();
}

function runDiscovery() {

  // 1 — repo's allowlist of existing labels (we never propose a label not already on the repo)
  const repoLabels = listRepoLabels(repo);
  console.error(`gh label list returned ${repoLabels.size} labels for ${repo}`);
  if (repoLabels.size === 0) {
    console.error(`refusing to run: repo ${repo} has no labels listed via gh — confirm gh auth + repo access`);
    process.exit(2);
  }
  if (repoLabels.size < 10) {
    console.error(
      `refusing to run: only ${repoLabels.size} labels returned for ${repo}; ` +
      `expected ≥ 10 for a project with a triage taxonomy. Possible gh truncation.`,
    );
    process.exit(2);
  }

  // 2 — find the area labels worth grouping by (≥ min-label-population uses on open threads)
  let areaCandidates = selectAreaCandidates(repoLabels);
  console.error(`area candidates after meta/prefix/allowlist filters: ${areaCandidates.length}`);
  if (areaCandidates.length === 0) {
    console.error("no area labels meet the population threshold; nothing to import");
    process.exit(0);
  }

  // 2b — operator-driven scoping: --label foo restricts discovery to a
  // single area, so areas can be rolled out one at a time. Match must
  // be exact against a label that already passed the area filters; an
  // unknown label exits cleanly so a typo doesn't silently produce
  // zero jobs.
  if (labelFilter) {
    const before = areaCandidates;
    areaCandidates = before.filter((entry) => entry.label === labelFilter);
    if (areaCandidates.length === 0) {
      const sample = before.slice(0, 8).map((entry) => entry.label).join(", ");
      console.error(
        `--label '${labelFilter}' did not match any area candidate. ` +
        `Available area candidates include: ${sample}${before.length > 8 ? ", ..." : ""}`,
      );
      process.exit(2);
    }
    console.error(`--label filter narrowed to: ${areaCandidates[0].label}`);
  }

  // 3 — pull untriaged issues from the cohort window
  const untriaged = selectUntriagedIssues(sinceHours);
  if (untriaged.length === 0) {
    console.error(`no untriaged issues in last ${sinceHours}h; nothing to import`);
    process.exit(0);
  }

  // 4 — skip-existing: per-slug AND per-candidate-overlap. Member
  // overlap mirrors import-gitcrawl-clusters.mjs's existingMemberRefs
  // pattern — a candidate already covered by another open job
  // shouldn't be in a new one (avoids cross-day overlap when an
  // untriaged issue persists past the cohort window).
  const { existingClusterSlugs, existingMemberRefs } = skipExisting
    ? scanExistingLabelUntriaged(outDir)
    : { existingClusterSlugs: new Set(), existingMemberRefs: new Map() };

  // 5 — for each candidate area, find untriaged issues whose TITLE
  // matches the area keyword (body-only matches are too noisy and
  // excluded — see C1 in the design review). Cross-check via
  // cluster_memberships: bonus confidence if the issue is in a
  // cluster whose other members carry the area label.
  const groups = groupUntriagedByArea(untriaged, areaCandidates);

  // 6 — for each group with at least min-untriaged candidates after
  // filtering, emit a job
  let createdCount = 0;
  for (const { label, candidates, evidenceByNumber } of groups) {
    if (createdCount >= limit) break;
    const filteredCandidates = candidates.filter((c) => {
      if (skipSecurity && hasSecuritySignalText(c.title, c.body, safeJson(c.labels_json))) {
        return false;
      }
      if (skipFeatureRequests && isProductFeatureRequest(c.title)) return false;
      // Member-overlap skip: candidate already covered by another open
      // label_untriaged job in the inbox.
      if (existingMemberRefs.has(c.number)) return false;
      return true;
    });
    if (filteredCandidates.length < minUntriaged) continue;

    const dateStamp = new Date().toISOString().slice(0, 10);
    const labelSlug = slugify(label);
    const clusterSlug = `label_untriaged-${labelSlug}-${dateStamp}`;
    if (existingClusterSlugs.has(clusterSlug)) {
      console.error(`skip existing cluster: ${clusterSlug}`);
      continue;
    }

    const fileStem = clusterSlug;
    const filePath = path.join(outDir, `${fileStem}.md`);
    const shippers = topShippersForLabel(label);

    const candidateRefs = filteredCandidates.map((c) => `#${c.number}`);
    const evidence = {
      title_token_match: collectMatchingTokens(filteredCandidates, evidenceByNumber),
      cluster_membership: collectClusterEvidence(filteredCandidates, evidenceByNumber),
      area_size_in_repo: areaCandidates.find((a) => a.label === label)?.count ?? 0,
      shippers_90d: shippers,
    };

    const markdown = buildJobMarkdown({
      repo,
      clusterSlug,
      mode,
      label,
      candidates: filteredCandidates,
      candidateRefs,
      evidence,
      sinceHours,
    });

    fs.writeFileSync(filePath, markdown);
    createdCount += 1;
    console.log(path.relative(repoRoot(), filePath));
  }

  if (createdCount === 0) {
    console.error(`no label_untriaged jobs created (sufficient candidates not found)`);
  }
}

// ---------- helpers ----------

function listRepoLabels(repoFullName) {
  try {
    const out = execFileSync(
      "gh",
      ["label", "list", "--repo", repoFullName, "--limit", "1000", "--json", "name"],
      { cwd: repoRoot(), encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
    ).trim();
    const arr = JSON.parse(out || "[]");
    return new Set(arr.map((entry) => entry.name).filter((name) => typeof name === "string"));
  } catch (err) {
    console.error(`warning: gh label list failed for ${repoFullName}: ${err?.message ?? err}`);
    return new Set();
  }
}

function selectAreaCandidates(repoLabels) {
  // High-frequency labels excluding meta-categories.
  // Population threshold gates against rarely-used labels that would produce
  // poorly-attributed shippers.
  const rows = sqliteJson(`
    select coalesce(json_extract(le.value, '$.name'), '') as label, count(*) as n
    from threads t, json_each(t.labels_json) le
    where t.state = 'open'
    group by label
    having n >= ${sqlNumber(minLabelPopulation)}
    order by n desc;
  `);
  return rows
    .map((r) => ({ label: String(r.label), count: Number(r.n) }))
    .filter(({ label }) => label.length > 0)
    .filter(({ label }) => !PROHIBITED_LABELS.has(label))
    .filter(({ label }) => !PROHIBITED_PREFIXES.some((p) => label.startsWith(p)))
    .filter(({ label }) => !label.startsWith("clawsweeper"))
    .filter(({ label }) => repoLabels.has(label)); // allowlist
}

function selectUntriagedIssues(hours) {
  // Pull only ISSUES (not PRs); PRs in this repo get labels reliably and
  // a separate pipeline handles their triage. R-10: only use columns the
  // gitcrawl-store snapshot reliably populates.
  return sqliteJson(`
    select t.id as thread_id, t.number, t.title, coalesce(t.body_excerpt, '') as body,
           t.labels_json, t.author_login, t.html_url, t.updated_at_gh
    from threads t
    where t.kind = 'issue'
      and t.state = 'open'
      and t.labels_json = '[]'
      and t.created_at_gh >= datetime('now', '-${sqlNumber(hours)} hours')
    order by t.updated_at_gh desc;
  `);
}

function groupUntriagedByArea(untriagedRows, candidateAreas) {
  // Prefix-strip + token-boundary regex per area, TITLE only — body
  // tokens generate too many false positives (an issue mentioning
  // "OpenAI" in passing while the title is about something else
  // entirely shouldn't be a candidate for `extensions: openai`).
  // Cluster-membership cross-check adds confidence but the primary
  // signal is the title match.
  //
  // An issue can match multiple areas; we count it toward EACH
  // matching area but route to the most-specific (smallest
  // population) area for the job. The evidence_by_number map tracks
  // tokens per the ROUTED primary area, not the first match found.
  const groups = new Map();
  const evidenceByNumber = new Map();
  for (const issue of untriagedRows) {
    const matches = inferAreas(issue, candidateAreas);
    if (matches.length === 0) continue;
    const primary = matches.sort((a, b) => a.count - b.count)[0];
    const list = groups.get(primary.label) ?? [];
    list.push(issue);
    groups.set(primary.label, list);
    evidenceByNumber.set(issue.number, {
      tokens: primary.tokens,
      clusterMembership: lookupClusterMembership(issue.thread_id, primary.label),
    });
  }
  return [...groups.entries()].map(([label, candidates]) => ({
    label,
    candidates,
    evidenceByNumber,
  }));
}

function inferAreas(issue, candidates) {
  // TITLE-ONLY token match. Body matches are intentionally excluded —
  // the design review (C1) showed body-only matches generate too many
  // false positives. The instruction file documents the title-as-
  // primary-signal heuristic; this enforces it structurally.
  const titleHaystack = String(issue.title ?? "").toLowerCase();
  const matches = [];
  for (const candidate of candidates) {
    const bareKey = candidate.label.replace(/^[^:]+:\s*/, "");
    if (bareKey.length < 4) continue; // 4-char minimum reduces false positives like "web" / "cli"
    const escaped = bareKey.toLowerCase().replace(/[\W]/g, "\\$&");
    const re = new RegExp(`\\b${escaped}\\b`, "i");
    const match = re.exec(titleHaystack);
    if (match) {
      matches.push({
        label: candidate.label,
        count: candidate.count,
        tokens: [match[0]],
      });
    }
  }
  return matches;
}

function lookupClusterMembership(threadId, label) {
  // Returns brief evidence string if this thread is in a cluster whose
  // members predominantly carry `label`; else empty string.
  // Skipped if cluster_groups table is missing (legacy gitcrawl schema).
  if (!hasClusterTables()) return "";
  const rows = sqliteJson(`
    select cg.id as cluster_id, cg.title as cluster_title
    from cluster_memberships cm
    join cluster_groups cg on cg.id = cm.cluster_id and cg.status = 'active'
    where cm.thread_id = ${sqlNumber(threadId)}
      and cm.state = 'active'
    limit 1;
  `);
  if (rows.length === 0) return "";
  const cluster = rows[0];
  // Check if any sibling members in this cluster carry the label
  const siblingLabelMatches = sqliteJson(`
    select count(*) as n
    from cluster_memberships cm
    join threads t on t.id = cm.thread_id
    where cm.cluster_id = ${sqlNumber(cluster.cluster_id)}
      and cm.state = 'active'
      and exists (
        select 1 from json_each(t.labels_json) le
        where coalesce(json_extract(le.value, '$.name'), '') = ${sqlString(label)}
      );
  `);
  const siblings = Number(siblingLabelMatches[0]?.n ?? 0);
  if (siblings === 0) return "";
  return `cluster #${cluster.cluster_id} (${siblings} sibling member${siblings === 1 ? "" : "s"} carry \`${label}\`)`;
}

let _hasClusterTablesCache = null;
function hasClusterTables() {
  if (_hasClusterTablesCache !== null) return _hasClusterTablesCache;
  const c = Number(sqliteScalar("select count(*) from sqlite_master where type='table' and name='cluster_groups';"));
  _hasClusterTablesCache = c > 0;
  return _hasClusterTablesCache;
}

function topShippersForLabel(label) {
  // R-03: derive recent shippers from closed PR authors in last 90 days
  // labeled with this area. closed_at_gh is reliable; merged_at_gh is
  // pruned in the gitcrawl-store snapshot.
  const rows = sqliteJson(`
    select t.author_login, count(*) as merged
    from threads t, json_each(t.labels_json) le
    where t.kind = 'pull_request'
      and t.state = 'closed'
      and t.closed_at_gh is not null
      and t.closed_at_gh >= datetime('now', '-90 days')
      and t.author_type = 'User'
      and coalesce(json_extract(le.value, '$.name'), '') = ${sqlString(label)}
    group by t.author_login
    order by merged desc
    limit 3;
  `);
  return rows.map((r) => `@${r.author_login} (${r.merged} closed PRs)`);
}

function collectMatchingTokens(candidates, evidenceByNumber) {
  const tokens = new Set();
  for (const c of candidates) {
    const ev = evidenceByNumber.get(c.number);
    for (const tok of ev?.tokens ?? []) tokens.add(tok);
  }
  return [...tokens];
}

function collectClusterEvidence(candidates, evidenceByNumber) {
  for (const c of candidates) {
    const ev = evidenceByNumber.get(c.number);
    if (ev?.clusterMembership) return ev.clusterMembership;
  }
  return "";
}

function buildJobMarkdown({ repo, clusterSlug, mode, label, candidates, candidateRefs, evidence, sinceHours }) {
  const evidenceLines = [
    `proposed_label_evidence:`,
    `  title_token_match:`,
    ...(evidence.title_token_match.length === 0
      ? ["    []"]
      : evidence.title_token_match.map((t) => `    - ${quoteYaml(t)}`)),
    ...(evidence.cluster_membership
      ? [`  cluster_membership: ${quoteYaml(evidence.cluster_membership)}`]
      : [`  cluster_membership: ""`]),
    `  area_size_in_repo: ${evidence.area_size_in_repo}`,
    `  shippers_90d:`,
    ...(evidence.shippers_90d.length === 0
      ? ["    []"]
      : evidence.shippers_90d.map((s) => `    - ${quoteYaml(s)}`)),
  ];
  const lines = [
    "---",
    `repo: ${repo}`,
    `cluster_id: ${clusterSlug}`,
    `mode: ${mode}`,
    "allowed_actions:",
    "  - label",
    "blocked_actions:",
    "  - close",
    "  - merge",
    "  - fix",
    "  - raise_pr",
    "require_human_for:",
    "  - security_sensitive",
    "  - low_confidence_match",
    "  - contradicting_area_keyword",
    "  - feature_request_shape",
    `triage_policy: label_untriaged`,
    `proposed_label: ${quoteYaml(label)}`,
    ...evidenceLines,
    `security_policy: central_security_only`,
    `security_sensitive: false`,
    `source: import-gitcrawl-untriaged`,
    ...yamlField("candidates", candidateRefs),
    `notes: ${quoteYaml(`${candidates.length} untriaged issues in last ${sinceHours}h matched area \`${label}\` by title-token signal.`)}`,
    "---",
    "",
    `# Untriaged label proposal — \`${label}\``,
    "",
    `Generated from gitcrawl on ${new Date().toISOString().slice(0, 10)}.`,
    "",
    "## Goal",
    "",
    goalText(mode, label),
    "",
    "## Candidates",
    "",
    ...bulletList(candidates),
    "",
  ];
  return lines.join("\n");
}

function goalText(mode, label) {
  if (mode === "plan") {
    return `Read-only proposal pass. For each candidate issue, verify against \`${label}\`: does the issue title or body genuinely concern this area? Return per-candidate verdict in the action matrix as one of \`apply\` (high confidence), \`needs_human\` (uncertain), or \`reject\` (false positive). Do not propose \`apply\` if the candidate's body contradicts the title token, if the candidate is a feature request rather than a bug or incident, or if the candidate could equally fit two unrelated areas. Do not propose any label other than \`${label}\`.`;
  }
  return `Run one autonomous classification pass against \`${label}\` for the listed candidates. Verify live GitHub state immediately before any \`apply\`. Return \`apply\` only when the title-token match plus body confirmation are both unambiguous. Otherwise return \`needs_human\`. Never apply a label other than \`${label}\`. Skip any candidate already labeled by another mechanism since the proposal was generated.`;
}

function bulletList(rows) {
  if (rows.length === 0) return ["- none"];
  return rows.map((r) => `- #${r.number} ${r.title}`);
}

function scanExistingLabelUntriaged(dir) {
  // Walks the inbox dir and returns:
  //   existingClusterSlugs: Set of slugs from frontmatter cluster_id
  //     of any label_untriaged job already on disk (including from
  //     prior days). Same-day re-runs are no-ops.
  //   existingMemberRefs: Map of issue number → file path. A
  //     candidate already in another label_untriaged job is skipped
  //     in this run — avoids cross-day overlap when an untriaged
  //     issue persists past the cohort window.
  const slugs = new Set();
  const memberRefs = new Map();
  if (!fs.existsSync(dir)) return { existingClusterSlugs: slugs, existingMemberRefs: memberRefs };
  for (const entry of fs.readdirSync(dir, { recursive: true })) {
    const file = path.join(dir, String(entry));
    if (!file.endsWith(".md") || !fs.statSync(file).isFile()) continue;
    const text = fs.readFileSync(file, "utf8");
    // Only scan label_untriaged jobs — other policies' candidates
    // aren't relevant to overlap detection here.
    const slugMatch = text.match(/^cluster_id:\s*(label_untriaged-[A-Za-z0-9-]+)\s*$/m);
    if (!slugMatch) continue;
    slugs.add(slugMatch[1]);
    const frontmatter = text.match(/^---\n([\s\S]*?)\n---/);
    const candidates = frontmatter?.[1].match(/^candidates:\n((?:  - .+\n?)*)/m)?.[1] ?? "";
    for (const m of candidates.matchAll(/#(\d+)/g)) {
      const number = Number(m[1]);
      if (Number.isSafeInteger(number)) memberRefs.set(number, path.relative(repoRoot(), file));
    }
  }
  return { existingClusterSlugs: slugs, existingMemberRefs: memberRefs };
}

// ---------- low-level shared with import-gitcrawl-clusters ----------

function sqliteJson(sql) {
  const output = execFileSync("sqlite3", ["-json", dbPath, sql], {
    cwd: repoRoot(),
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  }).trim();
  return JSON.parse(output || "[]");
}

function sqliteScalar(sql) {
  const output = execFileSync("sqlite3", [dbPath, sql], {
    cwd: repoRoot(),
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  }).trim();
  return output;
}

function numberArg(name, fallback) {
  const value = Number(args[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1) throw new Error(`--${name} must be a positive integer`);
  return value;
}

function sqlNumber(value) {
  if (!Number.isSafeInteger(Number(value))) {
    throw new Error(`unsafe number for SQL: ${value}`);
  }
  return String(Number(value));
}

function sqlString(value) {
  // Strict single-quote escape — these strings are literal repo labels
  // selected from a known set, never user input. Defense in depth.
  return `'${String(value).replace(/'/g, "''")}'`;
}

function safeJson(value) {
  try {
    return JSON.parse(value || "[]");
  } catch {
    return [];
  }
}

function isProductFeatureRequest(title) {
  return /^\s*\[?\s*feature(?:\s+(?:request|proposal))?\b/i.test(String(title ?? ""));
}

function yamlField(name, values) {
  if (values.length === 0) return [`${name}: []`];
  return [`${name}:`, ...values.map((value) => `  - ${quoteYaml(value)}`)];
}

function quoteYaml(value) {
  return JSON.stringify(String(value));
}

function slugify(value) {
  return (
    String(value)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64)
      .replace(/-+$/g, "") || "label"
  );
}
