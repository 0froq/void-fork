import {
  S_STEP_ACTIVE,
  S_STEP_SUBMIT,
  S_BAR,
  S_BAR_END,
  S_RADIO_ACTIVE,
  S_RADIO_INACTIVE,
  S_CHECKBOX_ACTIVE,
  S_CHECKBOX_INACTIVE,
} from "@clack/prompts";
import { pc } from "./output";

export interface FlagDef {
  name: string; // e.g. "--output" (include dashes)
  description: string;
  arg?: string; // e.g. "<path>" — flag takes a value
}

export interface SubcommandDef {
  name: string;
  description: string;
  arg?: string; // e.g. "<name>" — shown as dim hint, enables inline text input
  flags?: FlagDef[];
}

export interface SubcommandResult {
  subcommand: string;
  arg?: string;
  flags?: Record<string, string | true>;
}

export function promptSubcommand(
  command: string,
  subcommands: SubcommandDef[],
): Promise<SubcommandResult | null> {
  return new Promise((resolve) => {
    const { stdin, stdout } = process;

    type Phase = "select" | "flags";
    let phase: Phase = "select";
    let cursor = 0;
    let input = "";
    let prevLineCount = 0;
    let resolved = false;

    // Set after subcommand selection, used during flags phase
    let selectedSub: SubcommandDef | null = null;
    let selectedArg: string | undefined;
    let flagStates: { enabled: boolean; value: string }[] = [];

    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    stdout.write("\x1B[?25l"); // hide cursor

    function clear() {
      if (prevLineCount > 0) {
        stdout.write(`\x1B[${prevLineCount}A\x1B[0J`);
      }
    }

    function render() {
      clear();
      if (phase === "select") renderSelect();
      else renderFlags();
    }

    function renderSelect() {
      const lines: string[] = [];
      const focused = subcommands[cursor];

      lines.push(`${pc.cyan(S_STEP_ACTIVE)}  ${pc.cyan(`void ${command}`)}`);
      lines.push(pc.gray(S_BAR));

      const maxName = Math.max(...subcommands.map((s) => s.name.length));

      for (let i = 0; i < subcommands.length; i++) {
        const sub = subcommands[i];
        const isFocused = i === cursor;
        const radio = isFocused ? pc.green(S_RADIO_ACTIVE) : pc.dim(S_RADIO_INACTIVE);
        const name = sub.name.padEnd(maxName);

        let argText = "";
        if (sub.arg) {
          if (isFocused && input.length > 0) {
            argText = `  ${pc.cyan(input)}`;
          } else {
            argText = `  ${pc.dim(sub.arg)}`;
          }
        }

        if (isFocused) {
          lines.push(`${pc.gray(S_BAR)}  ${radio} ${pc.reset(name)}${argText}`);
        } else {
          lines.push(`${pc.gray(S_BAR)}  ${radio} ${pc.dim(name)}${argText}`);
        }
      }

      lines.push(pc.gray(S_BAR));
      lines.push(`${pc.gray(S_BAR)}  ${pc.dim(focused.description)}`);
      lines.push(pc.gray(S_BAR_END));

      stdout.write(lines.join("\n") + "\n");
      prevLineCount = lines.length;
    }

    function renderFlags() {
      const flags = selectedSub!.flags!;
      const focused = flags[cursor];
      const lines: string[] = [];

      // Header shows selected command + subcommand
      const argPart = selectedArg ? ` ${selectedArg}` : "";
      lines.push(
        `${pc.cyan(S_STEP_ACTIVE)}  ${pc.cyan(`void ${command}`)} ${pc.dim("·")} ${pc.cyan(`${selectedSub!.name}${argPart}`)}`,
      );
      lines.push(pc.gray(S_BAR));

      const maxFlag = Math.max(...flags.map((f) => f.name.length));

      for (let i = 0; i < flags.length; i++) {
        const flag = flags[i];
        const state = flagStates[i];
        const isFocused = i === cursor;

        const checkbox = state.enabled
          ? pc.green(S_CHECKBOX_ACTIVE)
          : isFocused
            ? S_CHECKBOX_INACTIVE
            : pc.dim(S_CHECKBOX_INACTIVE);
        const name = flag.name.padEnd(maxFlag);

        let valueText = "";
        if (flag.arg) {
          if (state.enabled && state.value.length > 0) {
            valueText = `  ${isFocused ? pc.cyan(state.value) : pc.dim(state.value)}`;
          } else {
            valueText = `  ${pc.dim(flag.arg)}`;
          }
        }

        if (isFocused) {
          lines.push(`${pc.gray(S_BAR)}  ${checkbox} ${pc.reset(name)}${valueText}`);
        } else {
          lines.push(`${pc.gray(S_BAR)}  ${checkbox} ${pc.dim(name)}${valueText}`);
        }
      }

      lines.push(pc.gray(S_BAR));
      lines.push(`${pc.gray(S_BAR)}  ${pc.dim(focused.description)}`);
      lines.push(pc.gray(S_BAR_END));

      stdout.write(lines.join("\n") + "\n");
      prevLineCount = lines.length;
    }

    function cleanup() {
      if (resolved) return;
      resolved = true;
      stdin.setRawMode(wasRaw);
      stdin.pause();
      stdin.removeListener("data", onData);
      stdout.write("\x1B[?25h"); // show cursor
    }

    function submit(result: SubcommandResult | null) {
      cleanup();
      clear();

      if (result) {
        let summary = result.subcommand;
        if (result.arg) summary += ` ${result.arg}`;
        if (result.flags) {
          for (const [flag, value] of Object.entries(result.flags)) {
            summary += ` ${flag}`;
            if (typeof value === "string") summary += ` ${value}`;
          }
        }
        stdout.write(
          `${pc.gray(S_STEP_SUBMIT)}  ${pc.dim(`void ${command}`)} ${pc.dim("·")} ${pc.dim(summary)}\n`,
        );
      }

      resolve(result);
    }

    function enterFlagsPhase(sub: SubcommandDef, arg: string | undefined) {
      selectedSub = sub;
      selectedArg = arg;
      phase = "flags";
      cursor = 0;
      flagStates = sub.flags!.map(() => ({ enabled: false, value: "" }));
      render();
    }

    function handleSelectKey(key: string) {
      const focused = subcommands[cursor];

      // Up
      if (key === "\x1B[A" || key === "\x1BOA") {
        cursor = cursor === 0 ? subcommands.length - 1 : cursor - 1;
        input = "";
        render();
        return;
      }
      // Down
      if (key === "\x1B[B" || key === "\x1BOB") {
        cursor = (cursor + 1) % subcommands.length;
        input = "";
        render();
        return;
      }

      // Enter
      if (key === "\r" || key === "\n") {
        if (focused.arg && input.length === 0) return;

        const arg = focused.arg ? input || undefined : undefined;

        if (focused.flags && focused.flags.length > 0) {
          clear();
          enterFlagsPhase(focused, arg);
        } else {
          submit({ subcommand: focused.name, arg });
        }
        return;
      }

      // Backspace
      if (key === "\x7F" || key === "\b") {
        if (focused.arg && input.length > 0) {
          input = input.slice(0, -1);
          render();
        }
        return;
      }

      // Printable characters — only if focused subcommand has arg
      if (focused.arg && key.length === 1 && key >= " ") {
        input += key;
        render();
      }
    }

    function handleFlagKey(key: string) {
      const flags = selectedSub!.flags!;
      const focused = flags[cursor];
      const state = flagStates[cursor];

      // Up
      if (key === "\x1B[A" || key === "\x1BOA") {
        cursor = cursor === 0 ? flags.length - 1 : cursor - 1;
        render();
        return;
      }
      // Down
      if (key === "\x1B[B" || key === "\x1BOB") {
        cursor = (cursor + 1) % flags.length;
        render();
        return;
      }

      // Space — toggle flag
      if (key === " ") {
        state.enabled = !state.enabled;
        if (!state.enabled) state.value = "";
        render();
        return;
      }

      // Enter — submit flags
      if (key === "\r" || key === "\n") {
        // Block if any enabled value flag has empty value
        for (let i = 0; i < flags.length; i++) {
          if (flagStates[i].enabled && flags[i].arg && flagStates[i].value.length === 0) {
            return;
          }
        }

        const result: SubcommandResult = {
          subcommand: selectedSub!.name,
          arg: selectedArg,
        };

        const enabledFlags: Record<string, string | true> = {};
        for (let i = 0; i < flags.length; i++) {
          if (flagStates[i].enabled) {
            enabledFlags[flags[i].name] = flags[i].arg ? flagStates[i].value : true;
          }
        }
        if (Object.keys(enabledFlags).length > 0) {
          result.flags = enabledFlags;
        }

        submit(result);
        return;
      }

      // Backspace — delete char from value
      if (key === "\x7F" || key === "\b") {
        if (focused.arg && state.enabled && state.value.length > 0) {
          state.value = state.value.slice(0, -1);
          render();
        }
        return;
      }

      // Printable characters — type value for enabled value flag (auto-enables)
      if (focused.arg && key.length === 1 && key >= " ") {
        if (!state.enabled) state.enabled = true;
        state.value += key;
        render();
      }
    }

    function onData(data: Buffer) {
      if (resolved) return;
      const key = data.toString();

      // Ctrl+C
      if (key === "\x03") {
        submit(null);
        return;
      }
      // Escape
      if (key === "\x1B" && data.length === 1) {
        submit(null);
        return;
      }

      if (phase === "select") handleSelectKey(key);
      else handleFlagKey(key);
    }

    stdin.on("data", onData);

    // Safety cleanup on exit
    process.on("exit", () => {
      if (!resolved) {
        stdout.write("\x1B[?25h");
      }
    });

    render();
  });
}
