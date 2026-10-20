export type CreateArgs = {
  appName: string | undefined;
  initArgs: Array<string>;
};

// run() spawns through a shell on Windows, so only forward plain flags such as
// `--framework react` or `--deploy=none` to `void init`.
const INIT_ARG_PATTERN = /^[\w=-]+$/;

/** Split `create-void [name] [void init options]` into the name and the options. */
export function parseCreateArgs(argv: ReadonlyArray<string>): CreateArgs {
  const [first, ...rest] = argv;
  const appName = first !== undefined && !first.startsWith('-') ? first : undefined;
  const initArgs = appName === undefined ? [...argv] : rest;
  for (const arg of initArgs) {
    if (!INIT_ARG_PATTERN.test(arg)) {
      throw new Error(`create-void: Unsupported argument '${arg}'.`);
    }
  }
  return { appName, initArgs };
}
