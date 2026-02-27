# Lessons

## Worktrees + Submodules: How to merge back to root tree

**Problem:** A submodule pointer is a specific commit SHA. Committing the framework change in the worktree (on a detached HEAD) produces a SHA that only exists there. When you try to merge the platform branch back to main, `git submodule update` fails because the referenced commit doesn't exist in main's framework object store or the remote.

**Solution:** Get the changeset from each commit and manually re-apply them to the the framework submodule in root.

## Configuration Changes Checklist

After any change that modifies the configuration options (`void.json`), make sure to:

- Update `framework/packages/void/schema.json`
- Update public-facing docs (`framework/docs/config.md`)
- Update anything else relevant (e.g. types, validation, README references)
