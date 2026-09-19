---
name: land
description: >-
  Land the current Kindred changes on origin/main. Invoke only when the user
  explicitly requests landing or merging, not merely review, preparation,
  verification, or skill installation.
metadata:
  delta-action: land
---

# Land Kindred changes

Use this workflow only after the user has explicitly requested landing. A
`/land` invocation or Land Changes request already supplies that intent: do not
ask for merge permission again.

## Target and safety

- Work in the Kindred repository containing this skill.
- Land on `origin/main`. Do not publish through the `local` backlink remote.
- Inspect the status, diff, remotes, current branch, and latest remote state.
  Identify the requested change from the conversation and preserve unrelated
  user or agent work. If the intended scope cannot be distinguished safely,
  stop and ask one focused question.
- Never discard work, force-push, rewrite shared history, expose secrets, or
  alter branch protection.
- Use non-interactive Git commands. Make a focused commit containing only the
  requested source changes and required generated assets. Derive a concise
  commit message from the change.

## Verification

- Do not run test suites as part of landing.
- Inspect the final integrated diff for unresolved conflicts and unintended
  changes.
- For frontend source changes, run `npm run build` from `frontend/` and include
  the resulting tracked production assets under `src/kindred/static/dist/`.
  Treat a failed build as a blocker.
- For changes without frontend source, use lightweight static validation when
  useful, but do not block landing on unrelated repository tests.

## Integrate and publish

1. Fetch `origin` and compare the requested change with current
   `origin/main`.
2. Prepare a focused commit if the change is not already committed.
3. Integrate current `origin/main` without rewriting published history.
   Automatically resolve straightforward conflicts when the intended result is
   clear, preserving both the requested behavior and unrelated upstream work.
   If a resolution is ambiguous or unsafe, abort or leave the repository in a
   recoverable state, report that the change has not landed, and ask the user.
4. Perform the verification above against the final integrated tree.
5. Push the exact verified result to `origin/main` without force. If the remote
   advances, fetch, integrate, reverify as needed, and retry safely. Stop on
   denied access or any condition that would require overwriting remote work.
6. Query `origin/main` after the push and verify that it contains the exact
   resulting commit. A local commit, topic-branch push, or passing build alone
   is not successful landing.

## Report the outcome

When running in a subthread and `report_subthread_status` is available, report
the final outcome to the parent; otherwise report it directly in the current
conversation.

- Use `status: "success"` only after verifying the requested commit reached
  `origin/main`.
- Use `status: "failure"` for failed checks, conflicts that cannot be resolved
  safely, denied publication, or another genuine blocker. Explicitly say the
  change was not landed.
- Keep the title to a few sentence-case words and the description to one short
  line. Link the short commit SHA and the actual CI/check run when verified URLs
  exist. Omit unavailable links rather than inventing them.
- Do not report skill installation, preparation, a local commit, or routine
  progress as landing success. If safe recovery later succeeds, report the
  updated verified outcome.
