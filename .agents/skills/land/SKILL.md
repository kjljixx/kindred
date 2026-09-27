---
name: land
description: >-
  Land the current Kindred changes to the local checkout first, then origin/main.
  Invoke only when the user explicitly requests landing or merging, not merely
  review, preparation, verification, or skill installation.
metadata:
  delta-action: land
---

# Land Kindred changes

Use this workflow only after the user has explicitly requested landing. A
`/land` invocation or Land Changes request already supplies that intent: do not
ask for merge permission again.

## Target and safety

- Work in the Kindred repository containing this skill.
- Land the requested changes in the user's primary checkout first, then publish
  the integrated result to `origin/main`.
- Treat `local` as a backlink to the primary checkout, not as a normal remote
  destination for updating its checked-out branch. Inspect its URL and use the
  matching primary checkout path for the local merge.
- Inspect the status, diff, remotes, current branch, and latest remote state.
  Identify the requested change from the conversation and preserve unrelated
  user or agent work. If the intended scope cannot be distinguished safely,
  stop and ask one focused question.
- Before changing the primary checkout, verify it is on `main` with a clean
  worktree. Preserve any unrelated work; if it is not safe to merge directly,
  stop and ask the user rather than switching branches or stashing changes.
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

## Integrate locally, then publish

1. Prepare a focused commit if the requested change is not already committed.
2. Fetch `local` and `origin`; compare the requested change with the primary
   checkout's `main` and current `origin/main`.
3. Integrate the requested commit into the primary checkout's `main` first.
   Use a non-checked-out staging ref through `local` if needed to make the
   commit available there, then merge it from the primary checkout. Never push
   directly to the checked-out `main` through `local`. Do not overwrite or
   reset the primary checkout.
4. Verify the primary checkout's `main` contains the requested commit. If local
   `main` has diverged, preserve both histories with a merge when the outcome is
   clear; otherwise stop and ask the user. Do not proceed to `origin/main` until
   the local landing is verified.
5. Integrate current `origin/main` without rewriting published history.
   Automatically resolve straightforward conflicts when the intended result is
   clear, preserving both the requested behavior and unrelated upstream work.
   If a resolution is ambiguous or unsafe, leave the local landing intact,
   report that publication to `origin/main` did not complete, and ask the user.
6. Perform the verification above against the final integrated tree.
7. Push the exact verified result to `origin/main` without force. If the remote
   advances, fetch, integrate, reverify as needed, and retry safely. Stop on
   denied access or any condition that would require overwriting remote work.
8. Query `origin/main` after the push and verify that it contains the exact
   resulting commit. A local landing, topic-branch push, or passing build alone
   is not successful publication.

## Report the outcome

When running in a subthread and `report_subthread_status` is available, report
the final outcome to the parent; otherwise report it directly in the current
conversation.

- Use `status: "success"` only after verifying the requested commit was merged
  into the primary checkout and the integrated result reached `origin/main`.
- Use `status: "failure"` for failed checks, conflicts that cannot be resolved
  safely, denied publication, or another genuine blocker. State separately
  whether local landing and `origin/main` publication completed.
- Keep the title to a few sentence-case words and the description to one short
  line. Link the short commit SHA and the actual CI/check run when verified URLs
  exist. Omit unavailable links rather than inventing them.
- Do not report skill installation, preparation, a staging-ref push, a local
  commit, or routine progress as landing success. If safe recovery later
  succeeds, report the updated verified outcome.
