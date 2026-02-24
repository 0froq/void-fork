# Lessons

## Worktrees + Submodules: Don't Commit in the Worktree

**Problem:** A submodule pointer is a specific commit SHA. Committing the framework change in the worktree (on a detached HEAD) produces a SHA that only exists there. When you try to merge the platform branch back to main, `git submodule update` fails because the referenced commit doesn't exist in main's framework object store or the remote.

**Rule:** When a worktree touches the submodule, never commit in the worktree. Use it as a scratch workspace only.

**Flow:**

1. Do all work in the worktree (edit both framework + platform files, run builds/tests)
2. When ready, apply raw diffs to the main working tree:
   ```bash
   # Apply framework changes
   (cd worktree/framework && git diff) | (cd main/framework && git apply)
   # Apply platform changes
   (cd worktree && git diff -- <platform files>) | (cd main && git apply)
   ```
3. Commit in main following the normal flow:
   ```bash
   cd main/framework && git add . && git commit -m "feat: ..." && git push
   cd main && pnpm install && git add framework <files> && git commit -m "feat: ... (bump framework)"
   ```
