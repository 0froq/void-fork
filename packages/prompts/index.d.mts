import { AutocompletePrompt, CANCEL_SYMBOL, CANCEL_SYMBOL as CANCEL_SYMBOL$1, ClackSettings, State, Validate, isCancel, settings, updateSettings } from "@clack/core";
import { Readable, Writable } from "node:stream";
//#region src/common.d.ts
/** Wrap using visible columns rather than the length of ANSI escape sequences. */
export declare const wrapTextWithPrefix: (output: Writable | undefined, text: string, prefix: string, startPrefix?: string) => string;
export declare const getGuide: (opts?: CommonOptions) => boolean;
export declare const promptTitle: (message: string, state: State, opts: CommonOptions) => string;
export declare const optionText: (output: Writable | undefined, marker: string, label: string, format: (text: string) => string, suffix?: string) => string;
export declare const SELECT_INSTRUCTIONS: string[];
export declare const MULTISELECT_INSTRUCTIONS: string[];
export declare const formatInstructionFooter: (instructions: string[], hasGuide: boolean, output?: Writable) => string[];
export declare const unicode: boolean;
export declare const isCI: () => boolean;
export declare const isTTY: (output: Writable) => boolean;
export declare const unicodeOr: (c: string, fallback: string) => string;
export declare const S_POINTER_ACTIVE: string;
export declare const S_POINTER_INACTIVE = " ";
export declare const S_STEP_ACTIVE: string;
export declare const S_STEP_CANCEL: string;
export declare const S_STEP_ERROR: string;
export declare const S_STEP_SUBMIT: string;
export declare const S_BAR_START: string;
export declare const S_BAR: string;
export declare const S_BAR_END: string;
export declare const S_BAR_START_RIGHT: string;
export declare const S_BAR_END_RIGHT: string;
export declare const S_RADIO_ACTIVE: string;
export declare const S_RADIO_INACTIVE = " ";
export declare const S_CHECKBOX_ACTIVE: string;
export declare const S_CHECKBOX_SELECTED: string;
export declare const S_CHECKBOX_INACTIVE: string;
export declare const S_PASSWORD_MASK: string;
export declare const S_BAR_H: string;
export declare const S_CORNER_TOP_RIGHT: string;
export declare const S_CONNECT_LEFT: string;
export declare const S_CORNER_BOTTOM_RIGHT: string;
export declare const S_CORNER_BOTTOM_LEFT: string;
export declare const S_CORNER_TOP_LEFT: string;
export declare const S_INFO: string;
export declare const S_SUCCESS: string;
export declare const S_WARN: string;
export declare const S_ERROR: string;
export declare const completeColor: (value: string) => string;
declare const symbol$1: (state: State) => string;
export declare const symbolBar: (state: State) => string;
export interface CommonOptions {
  input?: Readable;
  output?: Writable;
  signal?: AbortSignal;
  withGuide?: boolean;
  /** Static output for screen readers; also respects settings and ACCESSIBLE. */
  accessible?: boolean;
  /**
   * Stable identifier used in snapshot-test milestones
   * (`<kind>:<testId>:<state>`). Only read when `VP_EMIT_MILESTONES=1`;
   * defaults to the prompt kind. Set it when a flow shows several prompts of
   * the same kind, so tests can target each one unambiguously.
   */
  testId?: string;
}
//#endregion
//#region src/select.d.ts
type Primitive = Readonly<string | boolean | number>;
export type Option<Value> = Value extends Primitive ? {
  /**
   * Internal data for this option.
   */
  value: Value;
  /**
   * The optional, user-facing text for this option.
   *
   * By default, the `value` is converted to a string.
   */
  label?: string;
  /**
   * An optional hint to display to the user when
   * this option might be selected.
   *
   * By default, no `hint` is displayed.
   */
  hint?: string;
  /**
   * Whether this option is disabled.
   * Disabled options are visible but cannot be selected.
   *
   * By default, options are not disabled.
   */
  disabled?: boolean;
} : {
  /**
   * Internal data for this option.
   */
  value: Value;
  /**
   * Required. The user-facing text for this option.
   */
  label: string;
  /**
   * An optional hint to display to the user when
   * this option might be selected.
   *
   * By default, no `hint` is displayed.
   */
  hint?: string;
  /**
   * Whether this option is disabled.
   * Disabled options are visible but cannot be selected.
   *
   * By default, options are not disabled.
   */
  disabled?: boolean;
};
export interface SelectOptions<Value> extends CommonOptions {
  message: string;
  options: Option<Value>[];
  initialValue?: Value;
  maxItems?: number;
  /** Show keyboard instructions (default: true). */
  showInstructions?: boolean;
}
export declare const select: <Value>(opts: SelectOptions<Value>) => Promise<Value | typeof CANCEL_SYMBOL$1>;
//#endregion
//#region src/autocomplete.d.ts
interface AutocompleteSharedOptions<Value> extends CommonOptions {
  /**
   * The message to display to the user.
   */
  message: string;
  /**
   * Available options for the autocomplete prompt.
   */
  options: Option<Value>[] | ((this: AutocompletePrompt<Option<Value>>) => Option<Value>[]);
  /**
   * Maximum number of items to display at once.
   */
  maxItems?: number;
  /**
   * Placeholder text to display when no input is provided.
   */
  placeholder?: string;
  /**
   * Validates the value
   */
  validate?: Validate<Value | Value[]>;
  /**
   * Custom filter function to match options against search input.
   * If not provided, a default filter that matches label, hint, and value is used.
   */
  filter?: (search: string, option: Option<Value>) => boolean;
}
export interface AutocompleteOptions<Value> extends AutocompleteSharedOptions<Value> {
  /**
   * The initial selected value.
   */
  initialValue?: Value;
  /**
   * The initial user input
   */
  initialUserInput?: string;
  /** Complete the focused suggestion on Tab (enabled by path). */
  completeOnTab?: boolean;
}
export declare const autocomplete: <Value>(opts: AutocompleteOptions<Value>) => Promise<Value | typeof CANCEL_SYMBOL$1>;
export interface AutocompleteMultiSelectOptions<Value> extends AutocompleteSharedOptions<Value> {
  /**
   * The initial selected values
   */
  initialValues?: Value[];
  /**
   * If true, at least one option must be selected
   */
  required?: boolean;
}
/**
 * Integrated autocomplete multiselect - combines type-ahead filtering with multiselect in one UI
 */
export declare const autocompleteMultiselect: <Value>(opts: AutocompleteMultiSelectOptions<Value>) => Promise<Value[] | typeof CANCEL_SYMBOL$1>;
//#endregion
//#region src/box.d.ts
export type BoxAlignment = 'left' | 'center' | 'right';
export interface BoxOptions extends CommonOptions {
  contentAlign?: BoxAlignment;
  titleAlign?: BoxAlignment;
  width?: number | 'auto';
  titlePadding?: number;
  contentPadding?: number;
  rounded?: boolean;
  formatBorder?: (text: string) => string;
}
export declare const box: (message?: string, title?: string, opts?: BoxOptions) => void;
//#endregion
//#region src/confirm.d.ts
export interface ConfirmOptions extends CommonOptions {
  message: string;
  active?: string;
  inactive?: string;
  initialValue?: boolean;
  vertical?: boolean;
}
export declare const confirm: (opts: ConfirmOptions) => Promise<boolean | typeof CANCEL_SYMBOL$1>;
//#endregion
//#region src/group.d.ts
type Prettify<T> = { [P in keyof T]: T[P]; } & {};
export type PromptGroupAwaitedReturn<T> = { [P in keyof T]: Exclude<Awaited<T[P]>, symbol>; };
export interface PromptGroupOptions<T> {
  /**
   * Control how the group can be canceled
   * if one of the prompts is canceled.
   */
  onCancel?: (opts: {
    results: Prettify<Partial<PromptGroupAwaitedReturn<T>>>;
  }) => void;
}
export type PromptGroup<T> = { [P in keyof T]: (opts: {
  results: Prettify<Partial<PromptGroupAwaitedReturn<Omit<T, P>>>>;
}) => undefined | Promise<T[P] | undefined>; };
/**
 * Define a group of prompts to be displayed
 * and return a results of objects within the group
 */
export declare const group: <T>(prompts: PromptGroup<T>, opts?: PromptGroupOptions<T>) => Promise<Prettify<PromptGroupAwaitedReturn<T>>>;
//#endregion
//#region src/group-multi-select.d.ts
export interface GroupMultiSelectOptions<Value> extends CommonOptions {
  message: string;
  options: Record<string, Option<Value>[]>;
  initialValues?: Value[];
  required?: boolean;
  cursorAt?: Value;
  selectableGroups?: boolean;
  groupSpacing?: number;
  maxItems?: number;
  showInstructions?: boolean;
}
export declare const groupMultiselect: <Value>(opts: GroupMultiSelectOptions<Value>) => Promise<Value[] | typeof CANCEL_SYMBOL$1>;
//#endregion
//#region src/limit-options.d.ts
/**
 * Options for the {@link limitOptions} function.
 */
export interface LimitOptionsParams<TOption> extends CommonOptions {
  /**
   * The list of options to display.
   */
  options: TOption[];
  /**
   * The index of the currently active/selected option.
   */
  cursor: number;
  /**
   * A function that styles the given option string.
   *
   * @param option - The option string to style.
   * @param active - Whether the option is currently selected.
   */
  style: (option: TOption, active: boolean) => string;
  /**
   * Maximum number of options to display at once.
   * @default Infinity
   */
  maxItems?: number;
  /**
   * Number of columns to reserve for padding.
   * @default 0
   */
  columnPadding?: number;
  /**
   * Number of rows to reserve for padding.
   * @default 4
   */
  rowPadding?: number;
}
/**
 * Trims an option list to what fits the terminal, while keeping the active
 * option (cursor) visible using a Clack style sliding window.
 *
 * @returns The lines to render.
 *
 * @see https://bomb.sh/docs/clack/packages/prompts/#limitoptions
 *
 * @example
 * ```ts
 * import { limitOptions } from '@voidzero-dev/vite-plus-prompts';
 * import color from 'picocolors';
 *
 * const options = ['apple', 'banana', 'cherry', 'date'];
 * const lines = limitOptions({
 *   options,
 *   cursor: 2,
 *   maxItems: 8,
 *   style: (opt, active) =>
 *     active ? color.blue(opt) : color.dim(opt),
 * });
 * ```
 */
export declare const limitOptions: <TOption>({ cursor, options, style, output, maxItems, columnPadding, rowPadding }: LimitOptionsParams<TOption>) => string[];
//#endregion
//#region src/log.d.ts
export interface LogMessageOptions extends CommonOptions {
  symbol?: string;
  spacing?: number;
  secondarySymbol?: string;
}
export declare const log: {
  message: (message?: string | string[], { symbol, secondarySymbol, output, spacing, withGuide }?: LogMessageOptions) => void;
  info: (message: string, opts?: LogMessageOptions) => void;
  success: (message: string, opts?: LogMessageOptions) => void;
  step: (message: string, opts?: LogMessageOptions) => void;
  warn: (message: string, opts?: LogMessageOptions) => void;
  /** alias for `log.warn()`. */
  warning: (message: string, opts?: LogMessageOptions) => void;
  error: (message: string, opts?: LogMessageOptions) => void;
};
//#endregion
//#region src/messages.d.ts
export declare const cancel: (message?: string, opts?: CommonOptions) => void;
export declare const intro: (title?: string, opts?: CommonOptions) => void;
export declare const outro: (message?: string, opts?: CommonOptions) => void;
//#endregion
//#region src/milestone.d.ts
/**
 * Render-milestone markers for the PTY snapshot suite
 * (crates/vp_cli_snapshots): invisible window-title updates the runner
 * synchronizes on via `expect-milestone` interactions. Emission is gated on
 * `VP_EMIT_MILESTONES=1`, which only the runner sets; real terminals and
 * piped output never see these markers as content (they only update the
 * window title, which the runner's PTY captures).
 *
 * Protocol (shared with vite-task's `pty_terminal_test_client` crate):
 * `OSC 2 ; pty-terminal-test:<32-hex-id>:<base64url(name)> ST`. The runner
 * decodes the title with `decode_milestone_title`, ignoring ordinary title
 * updates. A fresh random id per emission keeps repeated milestones with the
 * same name observable as distinct title changes through Windows ConPTY.
 */
/**
 * Returns the encoded milestone byte sequence for `name`, or an empty string
 * when emission is disabled. Append the result to a rendered prompt frame so
 * the marker arrives in the output stream together with the render it marks.
 */
export declare function milestone(name: string): string;
/**
 * Milestone for a prompt render, following the runner naming convention
 * `<kind>:<id>:<state>` (e.g. `select:template:1`, `confirm:approve:yes`,
 * `text:project-name:my-app`). `id` defaults to the prompt kind; pass
 * `testId` at ambiguous call sites (multiple prompts of one kind in a flow).
 */
export declare function promptMilestone(kind: string, id: string | undefined, state: string): string;
//#endregion
//#region src/multi-select.d.ts
export interface MultiSelectOptions<Value> extends CommonOptions {
  message: string;
  options: Option<Value>[];
  initialValues?: Value[];
  maxItems?: number;
  required?: boolean;
  cursorAt?: Value;
  showInstructions?: boolean;
}
export declare const multiselect: <Value>(opts: MultiSelectOptions<Value>) => Promise<Value[] | typeof CANCEL_SYMBOL$1>;
//#endregion
//#region src/note.d.ts
export interface NoteOptions extends CommonOptions {
  /** Format note content; readable, un-dimmed text by default. */
  format?: (line: string) => string;
}
/** A compact, enclosed note. Guide bars never replace its side borders. */
export declare const note: (message?: string, title?: string, opts?: NoteOptions) => void;
//#endregion
//#region src/password.d.ts
export interface PasswordOptions extends CommonOptions {
  message: string;
  mask?: string;
  /** Hint displayed only while the password is empty. */
  placeholder?: string;
  validate?: Validate<string>;
  clearOnError?: boolean;
}
export declare const password: (opts: PasswordOptions) => Promise<string | typeof CANCEL_SYMBOL$1>;
//#endregion
//#region src/path.d.ts
/**
 * Options for the {@link path} prompt.
 */
export interface PathOptions extends CommonOptions {
  /**
   * The message or question shown to the user above the input.
   */
  message: string;
  /**
   * The starting directory for path suggestions (defaults to current working directory).
   */
  root?: string;
  /**
   * When `true` only **directories** appear in suggestions while you navigate.
   */
  directory?: boolean;
  /**
   * The starting path shown when the prompt first renders, which users can edit
   * before submitting. If not provided it will fall back to the given `root`,
   * or the current working directory.
   *
   * In `directory` mode, if the initial value points to a directory that exists,
   * pressing enter will submit the input instead of jumping to the first child.
   */
  initialValue?: string;
  /**
   * A function or a [Standard Schema](https://github.com/standard-schema/standard-schema)
   * that validates user input. If a custom function is given, you should return a `string` or `Error`
   * to show as a validation error, or `undefined` to accept the result.
   */
  validate?: Validate<string>;
}
/**
 * The `path` prompt extends `autocomplete` to provide file and directory suggestions.
 *
 * @see https://bomb.sh/docs/clack/packages/prompts/#path-selection
 *
 * @example
 * ```ts
 * import { path } from '@voidzero-dev/vite-plus-prompts';
 *
 * const result = await path({
 *   message: 'Select a file:',
 *   root: process.cwd(),
 *   directory: false,
 * });
 * ```
 */
export declare const path: (opts: PathOptions) => Promise<string | typeof CANCEL_SYMBOL$1>;
//#endregion
//#region src/spinner.d.ts
export interface SpinnerOptions extends CommonOptions {
  indicator?: 'dots' | 'timer';
  onCancel?: () => void;
  cancelMessage?: string;
  errorMessage?: string;
  frames?: string[];
  delay?: number;
  styleFrame?: (frame: string) => string;
}
export interface SpinnerResult {
  start(msg?: string): void;
  pause(): void;
  resume(msg?: string): void;
  stop(msg?: string): void;
  cancel(msg?: string): void;
  error(msg?: string): void;
  message(msg?: string): void;
  clear(): void;
  readonly isCancelled: boolean;
}
export declare const spinner: ({ indicator, onCancel, output, cancelMessage, errorMessage, frames, delay, signal, ...opts }?: SpinnerOptions) => SpinnerResult;
//#endregion
//#region src/progress-bar.d.ts
export interface ProgressOptions extends SpinnerOptions {
  style?: 'light' | 'heavy' | 'block';
  max?: number;
  size?: number;
}
export interface ProgressResult extends SpinnerResult {
  advance(step?: number, msg?: string): void;
}
export declare function progress({ style, max: userMax, size: userSize, ...spinnerOptions }?: ProgressOptions): ProgressResult;
//#endregion
//#region src/select-key.d.ts
export interface SelectKeyOptions<Value extends string> extends CommonOptions {
  message: string;
  options: Option<Value>[];
  initialValue?: Value;
  caseSensitive?: boolean;
}
export declare const selectKey: <Value extends string>(opts: SelectKeyOptions<Value>) => Promise<Value | typeof CANCEL_SYMBOL$1>;
//#endregion
//#region src/stream.d.ts
export declare const stream: {
  message: (iterable: Iterable<string> | AsyncIterable<string>, { symbol }?: LogMessageOptions) => Promise<void>;
  info: (iterable: Iterable<string> | AsyncIterable<string>) => Promise<void>;
  success: (iterable: Iterable<string> | AsyncIterable<string>) => Promise<void>;
  step: (iterable: Iterable<string> | AsyncIterable<string>) => Promise<void>;
  warn: (iterable: Iterable<string> | AsyncIterable<string>) => Promise<void>;
  /** alias for `log.warn()`. */
  warning: (iterable: Iterable<string> | AsyncIterable<string>) => Promise<void>;
  error: (iterable: Iterable<string> | AsyncIterable<string>) => Promise<void>;
};
//#endregion
//#region src/task.d.ts
export type Task = {
  /**
   * Task title
   */
  title: string;
  /**
   * Task function
   */
  task: (message: (string: string) => void) => string | Promise<string> | void | Promise<void>;
  /**
   * If enabled === false the task will be skipped
   */
  enabled?: boolean;
};
/**
 * Define a group of tasks to be executed
 */
export declare const tasks: (tasks: Task[], opts?: CommonOptions) => Promise<void>;
//#endregion
//#region src/task-log.d.ts
export interface TaskLogOptions extends CommonOptions {
  title: string;
  limit?: number;
  spacing?: number;
  retainLog?: boolean;
}
export interface TaskLogMessageOptions {
  raw?: boolean;
}
export interface TaskLogCompletionOptions {
  showLog?: boolean;
}
/**
 * Renders a log which clears on success and remains on failure
 */
export declare const taskLog: (opts: TaskLogOptions) => {
  message(msg: string, mopts?: TaskLogMessageOptions): void;
  group(name: string): {
    message(msg: string, mopts?: TaskLogMessageOptions): void;
    error(message: string): void;
    success(message: string): void;
  };
  error(message: string, opts?: TaskLogCompletionOptions): void;
  success(message: string, opts?: TaskLogCompletionOptions): void;
};
//#endregion
//#region src/text.d.ts
export interface TextOptions extends CommonOptions {
  message: string;
  placeholder?: string;
  defaultValue?: string;
  initialValue?: string;
  validate?: Validate<string>;
}
export declare const text: (opts: TextOptions) => Promise<string | typeof CANCEL_SYMBOL$1>;
//#endregion
export { CANCEL_SYMBOL, type ClackSettings, isCancel, settings, symbol$1 as symbol, updateSettings };