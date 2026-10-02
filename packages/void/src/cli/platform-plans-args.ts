export const PLATFORM_PLAN_ACTIONS = [
  'show',
  'add',
  'set',
  'reset',
  'archive',
  'restore',
  'remove',
  'default',
  'sync',
] as const;
export type PlatformPlanAction = (typeof PLATFORM_PLAN_ACTIONS)[number];
export type PlatformPlansArgs = Readonly<{
  subcommand: 'config';
  configGroup: 'plans';
  action: PlatformPlanAction | '';
  target: string;
  connection: string;
  file: string;
  name: string;
  copy: string;
  replacement: string;
  json: boolean;
  plan: boolean;
  yes: boolean;
}>;

export function parsePlatformPlansArgs(args: ReadonlyArray<string>): PlatformPlansArgs {
  const positional: Array<string> = [];
  const flags = new Set<string>();
  const values = new Map<string, string>();
  const valueFlags = ['connection', 'file', 'name', 'copy', 'replacement'];
  for (let index = 1; index < args.length; index++) {
    const arg = args[index]!;
    if (!arg.startsWith('-')) {
      positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (
      !arg.startsWith('--') ||
      (!['json', 'plan', 'yes'].includes(name) && !valueFlags.includes(name))
    ) {
      throw new Error(`platform: Unknown config plans flag ${arg}.`);
    }
    if (flags.has(name) || values.has(name)) {
      throw new Error(`platform: Duplicate flag ${arg}.`);
    }
    if (!valueFlags.includes(name)) {
      flags.add(name);
      continue;
    }
    const value = args[++index];
    if (!value || value.startsWith('-')) {
      throw new Error(`platform: ${arg} requires a value.`);
    }
    values.set(name, value);
  }
  const [action = '', target = '', ...extra] = positional;
  if (extra.length || (action && !PLATFORM_PLAN_ACTIONS.includes(action as PlatformPlanAction))) {
    throw new Error(
      `platform: Usage: void platform config plans [${PLATFORM_PLAN_ACTIONS.join('|')}] [plan-id] [options].`,
    );
  }
  const needsTarget = action && action !== 'show' && action !== 'sync';
  if ((needsTarget && !target) || ((!action || action === 'sync') && target)) {
    throw new Error(
      `platform: ${action || 'config plans'} ${needsTarget ? 'requires' : 'does not accept'} a plan ID.`,
    );
  }
  for (const id of [target, values.get('copy'), values.get('replacement')].filter(Boolean)) {
    parsePlatformPlanId(id);
  }
  if (flags.has('plan') && flags.has('yes')) {
    throw new Error('platform: --plan and --yes cannot be combined.');
  }
  if ((!action || action === 'show') && (flags.has('plan') || flags.has('yes'))) {
    throw new Error('platform: Select a configuration change before using --plan or --yes.');
  }
  for (const [name, actions] of [
    ['file', ['add', 'set']],
    ['name', ['add', 'set']],
    ['copy', ['add']],
    ['replacement', ['remove']],
  ] as const) {
    if (values.has(name) && !(actions as ReadonlyArray<string>).includes(action)) {
      throw new Error(`platform: --${name} is only valid for ${actions.join(' or ')}.`);
    }
  }
  return {
    subcommand: 'config',
    configGroup: 'plans',
    action: action as PlatformPlanAction | '',
    target,
    connection: values.get('connection') ?? '',
    file: values.get('file') ?? '',
    name: values.get('name') ?? '',
    copy: values.get('copy') ?? '',
    replacement: values.get('replacement') ?? '',
    json: flags.has('json'),
    plan: flags.has('plan'),
    yes: flags.has('yes'),
  };
}
import { parsePlatformPlanId } from '@void/platform/plans';
