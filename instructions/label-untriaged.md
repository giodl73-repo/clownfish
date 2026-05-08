# Triage Policy: `label_untriaged`

> **Default: plan-only.** Discovery emits jobs as `mode: plan` so the
> worker's verdicts are read-only proposals for maintainer review.
> Promoting to `mode: execute` requires explicit `allow_label_apply:
> true` on the job; `apply-result.mjs` then runs `applyLabelAction`,
> which enforces label-equality against the job's `proposed_label`,
> re-checks security signal on live state, and performs a
> `target_updated_at` drift check before adding the label via `gh
> issue edit --add-label`. `validateJob` in `lib.mjs` enforces these
> invariants at job-load time.

This policy proposes a single repo label for each candidate untriaged
issue. The job carries one `proposed_label` (e.g. `gateway`,
`channel: discord`, `extensions: codex`) selected by the autonomous
discovery script (`import-gitcrawl-untriaged.mjs`) based on
title-token signal (cluster-membership cross-check adds confidence
when present).

The Codex worker's job is to validate per-candidate whether the
proposed label genuinely fits, returning one of `apply`, `needs_human`,
or `reject` for the maintainer's review.

## Allowed actions

- `label` — apply the job's `proposed_label` to a candidate issue.

## Blocked actions

- `close` — never close anything under this policy.
- `comment` — never comment on user issues. Labels apply silently.
- `merge` / `fix` / `raise_pr` — out of scope.
- Any label other than the job's `proposed_label`. The applicator
  rejects label-add attempts whose `label` field doesn't match the
  job's `proposed_label`.

## Per-candidate verdict criteria

Return `apply` only when ALL of these hold:

1. The candidate's title or body genuinely concerns the proposed
   label's area.
2. The title-token match is unambiguous (the matched word is the
   actual subject, not a contradicting reference like "discord-style
   formatting" in a telegram-area issue).
3. The candidate is a bug, incident, regression, or other operational
   report — not a feature request, marketing prose, or thanks-only
   issue.
4. The candidate's body, if present, does not explicitly contradict
   the proposed area (e.g. a "discord" title token but a body that's
   entirely about Slack).

Return `needs_human` when:

- Title-token match is present but body context is ambiguous or
  insufficient to confirm.
- The candidate could equally fit two unrelated areas.
- The candidate looks like a feature request, design proposal, or
  marketing-shaped post (the discovery script already filters most;
  apply this as defense in depth).
- The candidate's body indicates security-sensitive content not
  caught by the discovery filter (route to central security).

Return `reject` when:

- Title-token is a false positive (e.g. "discordant" matched
  `channel: discord`).
- The body is entirely about a different area than the title's token
  suggests.
- The candidate has been labeled or assigned since the proposal was
  generated (live state drift; the applicator will re-verify, but
  preempt the wasted apply if the worker can already see the drift).

## Bias toward `needs_human`

When evidence is weak, return `needs_human`. The applicator's
proposal-first / re-verify guards mean a `needs_human` is recoverable
(maintainer reviews + decides), but a wrong `apply` pollutes the
repo's label filters and creates rework.

## What the worker reads

Each job carries:

- `proposed_label` — the one label to validate. Never propose any
  other.
- `proposed_label_evidence` — discovery-time evidence (matched tokens,
  cluster membership if any, repo-wide population of the label,
  recent shippers in this area). Read-only context for your verdict.
- `candidates` — list of issue numbers (`#N`) to validate.

## What the worker does NOT do

- Does not invent new labels.
- Does not close or comment on candidates.
- Does not assign maintainers.
- Does not chain into other policies (e.g. doesn't close a candidate
  even if it looks like a duplicate; that's `low_signal_prs` /
  default cluster cleanup, separate jobs).

## Action matrix output

```jsonc
{
  "verdicts": [
    {
      "candidate": "#79443",
      "verdict": "apply",
      "reason": "Body confirms the issue is about Heimdall gateway monitor; title token \"Heimdall Monitor\" plus body mentions of \"gateway\" align with `gateway` label."
    },
    {
      "candidate": "#79412",
      "verdict": "needs_human",
      "reason": "Title and body refer to gateway behavior but issue may be a duplicate of #79436 — flag for cluster review before labeling."
    },
    {
      "candidate": "#79376",
      "verdict": "reject",
      "reason": "Title contains \"gateway\" token but body is exclusively about WhatsApp delivery recovery; should be `channel: whatsapp-web`, not `gateway`."
    }
  ]
}
```

## Confidence-signal heuristics (for the worker's reasoning)

- **Two corroborating signals → high confidence.** If the discovery's
  `cluster_membership` evidence is present AND the title-token match
  is in the title (not just the body), this is a strong proposal.
  Most should be `apply`.
- **Title-token only → medium confidence.** Read the body carefully.
  Bias toward `needs_human` for ambiguous bodies.
- **Body-token only → low confidence.** The title is the primary
  signal of an issue's subject. If the title doesn't mention the
  area but the body does, the area is probably secondary; bias
  toward `reject` or `needs_human`.

## Security routing

The discovery script skips issues whose title or body trips
`hasSecuritySignalText`. As defense in depth, if the worker reads a
candidate's body and finds security-sensitive content, return
`needs_human` with reason explicitly noting the security signal so
the applicator re-routes via `central_security_only`.

## Audit trail

Each verdict produces a record in `records/<repo-slug>/items/<number>.md`
following the standard clownfish record format. The record carries
the `proposed_label`, the verdict, the reason, and the snapshot hash
of the live GitHub state at decision time.
