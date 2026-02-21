# Using the Vite Cloud CLI

## Workflow

### Step 1: Load the skill

Load the `vite-cloud` skill and read `SKILL.md` for the decision tree.

### Step 2: Identify the task

Map the user's request to one of the reference files using the decision tree in `SKILL.md`. If the request spans multiple topics (e.g. "generate a model and deploy"), handle them sequentially.

### Step 3: Read the reference

Read only the relevant `references/<topic>.md` file. For full flag details beyond what the reference covers, run:

```sh
npx vite-cloud <command> --help
```

### Step 4: Execute

Before running commands, verify:

- **Auth**: `npx vite-cloud whoami` succeeds (or `VITE_CLOUD_TOKEN` is set in CI)
- **Link**: `.vite-cloud/project.json` exists for commands that need a project target (deploy, secrets, domains, delete)
- **Gen targets**: for `vite-cloud gen` commands, confirm the target file doesn't already exist (gen never overwrites)
- **DB state**: for `vite-cloud db` commands, check current status with `npx vite-cloud db status` before destructive operations

Run the command and capture output.

### Step 5: Verify

- Check command exit code (0 = success)
- For `deploy`: confirm the deploy URL in output
- For `gen`: verify the created files exist and have correct content
- For `db`: run `npx vite-cloud db status` to confirm migration state
- For `secret`: no output on success (exit code 0 is sufficient)
- For `domain add`: note the CNAME target printed in output — the user must configure this in their DNS provider
