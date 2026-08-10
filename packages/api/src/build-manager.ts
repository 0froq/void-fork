import { Container } from '@cloudflare/containers';
import { Terminal } from '@xterm/headless';
import {
  DEPLOY_TOKEN_HARD_MAX_MINUTES,
  deployTokenTtlSecondsForBuildMinutes,
  signDeployToken,
} from './auth/deploy-token.ts';
import { isTerminalBuildStatus } from './build-status.ts';
import { type BuildConfig, type BuildLogLine, isContainerCapacityError } from './build-types.ts';
import { SITE_DOMAIN } from './constants.ts';
import {
  createDb,
  getBuild,
  getDeploymentByProjectAndCommit,
  installationCoversRepo,
  markBuildBuildingIfStarting,
  markBuildProgressIfActive,
  markBuildTerminalIfActive,
  requeueBuildIfStarting,
  setBuildCheckRunId,
  type Db,
} from './db.ts';
import type { ApiEnv } from './env.ts';
import { type CheckRunConclusion, completeCheckRun, createCheckRun } from './github/check-run.ts';
import {
  generateSourceTarballUrl,
  getBranchHeadComparisonStatus,
  getInstallationToken,
} from './github/installation-token.ts';

/** DO storage keys for the build config captured at `startBuild()`. */
const STORAGE_KEY_CONFIG = 'buildConfig';
/** DO storage key for the per-build agent secret minted at `startBuild()`. */
const STORAGE_KEY_AGENT_TOKEN = 'agentToken';
/** DO storage key for the GitHub Check Run id created at `startBuild()`. */
const STORAGE_KEY_CHECK_RUN = 'checkRunId';

/** Build statuses past which no further transition should occur. */
const TERMINAL_STATUSES: ReadonlyArray<StoredBuildStatus> = ['complete', 'failed', 'cancelled'];

// Hard cap on rows retained in the DO SQLite `logs` table. A verbose/chatty build
// (huge installer/compiler output) would otherwise grow the table without bound
// for the build's lifetime — risking DO storage pressure and an O(rows) WebSocket
// replay on connect. `ingestLines` evicts the oldest rows past this cap, keeping
// the most-recent window (a tail is what a live log view wants). Mirrors the
// container agent's in-memory ring bound (build-agent.mjs MAX_BUFFERED_LOG_LINES).
export const MAX_STORED_LOG_LINES = 10000;

// Bounds for the log tail embedded in the completed check-run's `output.text`.
// Both caps are UTF-8 BYTE caps, because that is what GitHub validates (its
// 422 reads "maximum bytesize of 65535") — a UTF-16 `.length` cap would let
// CJK (~3 bytes per code unit) or emoji (4 bytes per 2 units) content pass our
// limit while far exceeding GitHub's. The 60000 content cap normally leaves
// fence/header/marker headroom under GitHub's 65535 cap, but the fence is
// sized past the content's backtick runs (see below), so the hard cap is
// enforced on the whole rendered string too.
export const CHECK_RUN_LOG_TAIL_LINES = 100;
export const CHECK_RUN_LOG_TAIL_MAX_BYTES = 60000;

// GitHub's hard cap on a check run's output.text: 65535 UTF-8 BYTES (GitHub
// validates bytesize, not character count). A longer string makes GitHub
// reject the entire PATCH — stranding the run with no text at all — so the
// WHOLE rendered string (header + marker + fence delimiters + content) must
// honor it, not just the content: the fence delimiters grow past the longest
// backtick run in the content, so a pathological all-backtick line can blow
// far past the fixed small overhead the 60000 content cap budgeted for.
export const CHECK_RUN_OUTPUT_TEXT_MAX_BYTES = 65535;

// Cadence of the DO→container log pull-loop. The agent buffers stdout/stderr and
// serves `GET /logs?since=N`; the DO polls on this interval, ingesting any new
// lines into the SQLite `logs` table + WS fan-out. ~1–2s keeps a live log view
// near-real-time without hammering the container. The loop is armed in `onStart`
// (first tick at 1s) and re-armed by `pollLogs` until the build is terminal.
const POLL_SECONDS = 1;

// Pin the build container's fallback Void CLI to the platform's shipped version.
// Used ONLY when the repo has no local `void` dependency to run; a repo that
// pins its own version is unaffected. Kept equal to
// framework/packages/void/package.json (the submodule the platform deploys
// against) so a moving `void@latest` can't change deploy behavior with no repo
// diff. The comment alone let this sit a full minor behind for the whole life of
// the feature, so `build-manager.test.ts` now asserts the equality instead.
export const PINNED_VOID_CLI_VERSION = '0.10.10';

// Ceiling on how long a queued build may wait for the just-in-time branch-head
// freshness recheck to succeed. While the GitHub compare API is unreachable
// (returns null) we requeue and retry on the next alarm; but no container is
// started on that path, so nothing would ever reap a persistently-null build —
// past this age we fail it rather than loop forever.
const FRESHNESS_VERIFY_MAX_AGE_MS = 30 * 60 * 1000;

// Idle safety-net for a stuck/orphaned container, expressed as the build's
// wall-clock hard max plus a margin so it can never cut a legitimately busy
// build short. `sleepAfter` is an IDLE timeout (not a wall-clock cap) and nothing
// renews it after start — the per-build wall-clock cap is `enforceTimeout`. Kept
// in lockstep with `DEPLOY_TOKEN_HARD_MAX_MINUTES` so the idle net always sits
// above the longest a build can legitimately run. The +15m margin matches the
// STALE reaper margin.
const SLEEP_AFTER_MINUTES = DEPLOY_TOKEN_HARD_MAX_MINUTES + 15;

/**
 * Constant-time string compare to avoid leaking the agent secret via response
 * timing. Length is compared up front (lengths aren't secret here), then every
 * byte is XORed so the loop runs the full length regardless of mismatch
 * position.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

// GitHub's output.text caps are UTF-8 bytesize caps — measure with one shared
// encoder (available in both Workers and the Node/Miniflare test env).
const utf8 = new TextEncoder();

function utf8Length(text: string): number {
  return utf8.encode(text).length;
}

/**
 * Drop `cut` leading UTF-16 code units from `line`, advancing one further when
 * the cut would land on a low surrogate (0xDC00–0xDFFF): slicing there strands
 * the low half of a split pair at the front of the kept tail, which re-encodes
 * as a 3-byte U+FFFD — garbage in the output (and bytes the caller's byte
 * accounting never budgeted for).
 */
function sliceTailAtUnit(line: string, cut: number): string {
  const code = line.charCodeAt(cut);
  return line.slice(code >= 0xdc00 && code <= 0xdfff ? cut + 1 : cut);
}

/** Longest run of consecutive backticks in `text` (0 when there are none). */
function longestBacktickRun(text: string): number {
  let longest = 0;
  for (const match of text.matchAll(/`+/g)) {
    if (match[0].length > longest) {
      longest = match[0].length;
    }
  }
  return longest;
}

/**
 * Fixed width shared with the xterm oracle. A width derived from raw input bytes
 * makes non-painting SGR sequences change the right margin and therefore the
 * visible output. 32K columns comfortably covers real build diagnostics while
 * keeping one headless grid to a few MiB.
 */
export const TERMINAL_RENDER_COLUMNS = 32 * 1024;

/**
 * Deterministic outer bounds around xterm. Worker clocks do not advance during
 * CPU work, so a `performance.now()` deadline cannot interrupt a hostile CSI.
 * Controlled rows larger than half the grid, or whose work-amplifying controls
 * exceed this aggregate budget, are omitted fail-closed before a grid is
 * allocated. The tail budget limits cumulative parser work across 100 rows.
 */
export const TERMINAL_RENDER_MAX_INPUT_CODE_UNITS = TERMINAL_RENDER_COLUMNS / 2;
export const TERMINAL_RENDER_MAX_PARAMETER_WORK = 8 * 1024;
export const TERMINAL_RENDER_MAX_REPEAT_CODE_UNITS = 1024 * 1024;
export const TERMINAL_TAIL_MAX_INPUT_CODE_UNITS = TERMINAL_RENDER_COLUMNS;
const TERMINAL_FULL_GRID_WORK = TERMINAL_RENDER_MAX_PARAMETER_WORK / 4;
const TERMINAL_ROW_MUTATION_WORK = 32;

function hasTerminalControl(raw: string): boolean {
  for (let index = 0; index < raw.length; index++) {
    const code = raw.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
      return true;
    }
  }
  return false;
}

interface TerminalPreflight {
  safe: boolean;
  controlledCodeUnits: number;
  parameterWork: number;
  repeatCodeUnits: number;
}

/**
 * Bound parameter-driven terminal work before it reaches xterm's handlers.
 * This is deliberately only a resource preflight, not another terminal model:
 * xterm remains authoritative for parsing and screen state. It recognizes CSI
 * framing well enough to charge work-amplifying commands and rejects insert
 * mode, whose printable path shifts the full row once per character.
 */
function preflightTerminalInput(
  raw: string,
  maxInputCodeUnits = TERMINAL_RENDER_MAX_INPUT_CODE_UNITS,
): TerminalPreflight {
  if (!hasTerminalControl(raw)) {
    return { safe: true, controlledCodeUnits: 0, parameterWork: 0, repeatCodeUnits: 0 };
  }
  if (raw.length > maxInputCodeUnits) {
    return {
      safe: false,
      controlledCodeUnits: raw.length,
      parameterWork: 0,
      repeatCodeUnits: 0,
    };
  }

  let state: 'ground' | 'escape' | 'escapeIntermediate' | 'csi' | 'csiIgnore' = 'ground';
  let parameterWork = 0;
  let repeatCodeUnits = 0;
  let precedingGraphicRun = 0;
  let parameterValue = 0;
  let parameterHasDigits = false;
  let csiHasParameterBytes = false;
  let csiPrefix = '';
  let csiIntermediates = '';
  let escapeIntermediates = '';
  let defaultTabStopsCleared = false;
  const csiParameters: Array<number> = [];

  const resetCsi = (): void => {
    parameterValue = 0;
    parameterHasDigits = false;
    csiHasParameterBytes = false;
    csiPrefix = '';
    csiIntermediates = '';
    csiParameters.length = 0;
  };
  const finishParameter = (): void => {
    if (!parameterHasDigits) {
      return;
    }
    csiParameters.push(parameterValue);
    parameterValue = 0;
    parameterHasDigits = false;
  };
  const spendWork = (units: number): boolean => {
    parameterWork += Math.max(1, units);
    return parameterWork <= TERMINAL_RENDER_MAX_PARAMETER_WORK;
  };
  const enterCsi = (): void => {
    resetCsi();
    state = 'csi';
  };

  for (let index = 0; index < raw.length; index++) {
    const code = raw.charCodeAt(index);
    // Executed C0/C1 controls clear xterm's preceding-graphic state. ESC and
    // CSI introducers preserve it just long enough for an immediately following
    // REP; executed controls and successfully dispatched sequences reset it.
    if ((code <= 0x1f && code !== 0x1b) || (code >= 0x80 && code <= 0x9f && code !== 0x9b)) {
      precedingGraphicRun = 0;
    }
    // After TBC 3 clears every stop, xterm's HT search can scan the full fixed
    // grid. Keep custom-tab semantics in xterm, but conservatively charge that
    // worst case until RIS restores the default stops.
    if (code === 0x09 && defaultTabStopsCleared && !spendWork(TERMINAL_FULL_GRID_WORK)) {
      return { safe: false, controlledCodeUnits: raw.length, parameterWork, repeatCodeUnits };
    }
    // These controls scroll the sole row and make xterm allocate/fill a fresh
    // 32K-column buffer line. Permit an isolated real control, but reject a
    // reset/scroll flood before constructing the terminal grid.
    if (
      (code === 0x0a ||
        code === 0x0b ||
        code === 0x0c ||
        code === 0x84 ||
        code === 0x85 ||
        code === 0x8d) &&
      !spendWork(TERMINAL_FULL_GRID_WORK)
    ) {
      return { safe: false, controlledCodeUnits: raw.length, parameterWork, repeatCodeUnits };
    }
    // C1 CSI is an anywhere transition in xterm, including string controls.
    if (code === 0x9b) {
      enterCsi();
      continue;
    }

    if (state === 'ground') {
      if (code === 0x1b) {
        escapeIntermediates = '';
        state = 'escape';
      } else if (code >= 0x20 && code <= 0x7e) {
        // Every printable ASCII byte starts a new xterm cell/grapheme. Keep the
        // conservative run bound only for non-ASCII code units, where combining
        // and joiner behavior can make one grapheme span many source units.
        precedingGraphicRun = 1;
      } else if (code > 0x1f && !(code >= 0x7f && code <= 0x9f)) {
        // Treat the whole printable run as one possible grapheme. This is
        // conservative for Unicode and exact for the hostile combining case.
        precedingGraphicRun += 1;
      }
      continue;
    }
    if (state === 'escape' || state === 'escapeIntermediate') {
      if (code === 0x18 || code === 0x1a) {
        state = 'ground';
      } else if (code === 0x1b) {
        escapeIntermediates = '';
        state = 'escape';
      } else if (code <= 0x1f || code === 0x7f) {
        // Ordinary C0 controls execute without leaving the escape state; DEL is
        // ignored. This matters for ESC BEL [ CSI routing.
      } else if (state === 'escape' && code === 0x5b) {
        enterCsi();
      } else if (code >= 0x20 && code <= 0x2f) {
        state = 'escapeIntermediate';
        escapeIntermediates += String.fromCharCode(code);
      } else if (code >= 0x30 && code <= 0x7e) {
        const fullGridEscape =
          (escapeIntermediates === '' &&
            (code === 0x44 || code === 0x45 || code === 0x4d || code === 0x63)) ||
          (escapeIntermediates === '#' && code === 0x38);
        if (fullGridEscape && !spendWork(TERMINAL_FULL_GRID_WORK)) {
          return { safe: false, controlledCodeUnits: raw.length, parameterWork, repeatCodeUnits };
        }
        if (escapeIntermediates === '' && code === 0x63) {
          defaultTabStopsCleared = false;
        }
        state = 'ground';
        precedingGraphicRun = 0;
      }
      continue;
    }
    if (state === 'csiIgnore') {
      if (code === 0x18 || code === 0x1a) {
        state = 'ground';
      } else if (code === 0x1b) {
        escapeIntermediates = '';
        state = 'escape';
      } else if (code >= 0x40 && code <= 0x7e) {
        state = 'ground';
      }
      continue;
    }

    // CSI entry/parameter/intermediate states. Embedded C0 controls execute and
    // stay in CSI; CAN/SUB abort; ESC restarts escape parsing.
    if (code === 0x18 || code === 0x1a) {
      state = 'ground';
      resetCsi();
      precedingGraphicRun = 0;
    } else if (code === 0x1b) {
      escapeIntermediates = '';
      state = 'escape';
      resetCsi();
    } else if (code <= 0x1f || code === 0x7f) {
      continue;
    } else if (code >= 0x30 && code <= 0x39 && csiIntermediates === '') {
      csiHasParameterBytes = true;
      parameterHasDigits = true;
      parameterValue = Math.min(
        TERMINAL_RENDER_MAX_PARAMETER_WORK + 1,
        parameterValue * 10 + code - 0x30,
      );
      if (parameterValue > TERMINAL_RENDER_MAX_PARAMETER_WORK) {
        return { safe: false, controlledCodeUnits: raw.length, parameterWork, repeatCodeUnits };
      }
    } else if ((code === 0x3a || code === 0x3b) && csiIntermediates === '') {
      csiHasParameterBytes = true;
      finishParameter();
    } else if (code >= 0x3c && code <= 0x3f && csiIntermediates === '') {
      if (csiPrefix !== '' || csiHasParameterBytes) {
        // xterm enters CSI_IGNORE when a second private marker appears or a
        // marker follows parameters. An ignored sequence does not dispatch and
        // therefore does not clear REP's preceding-graphic source.
        state = 'csiIgnore';
        resetCsi();
      } else {
        csiPrefix = String.fromCharCode(code);
      }
    } else if (code >= 0x20 && code <= 0x2f) {
      finishParameter();
      csiIntermediates += String.fromCharCode(code);
    } else if (code >= 0x40 && code <= 0x7e) {
      finishParameter();
      const firstParameter = csiParameters[0] || 1;
      if (csiPrefix === '' && csiIntermediates === '' && code === 0x67 && firstParameter === 3) {
        defaultTabStopsCleared = true;
      }
      // REP allocates `precedingGrapheme.length * Ps` code points before it
      // paints. A grapheme can contain most of the input as combining marks, so
      // the generic Ps sum alone is not a memory bound.
      if (code === 0x62 && csiPrefix === '' && csiIntermediates === '') {
        repeatCodeUnits += precedingGraphicRun * (csiParameters[0] || 1);
        if (repeatCodeUnits > TERMINAL_RENDER_MAX_REPEAT_CODE_UNITS) {
          return { safe: false, controlledCodeUnits: raw.length, parameterWork, repeatCodeUnits };
        }
      }
      // ANSI insert mode makes every subsequent printable character shift the
      // entire row. It is irrelevant to build output and unsafe to hand to a
      // dense terminal grid under attacker-controlled input.
      if (
        code === 0x68 &&
        csiPrefix === '' &&
        csiIntermediates === '' &&
        csiParameters.includes(4)
      ) {
        return { safe: false, controlledCodeUnits: raw.length, parameterWork, repeatCodeUnits };
      }
      let commandWork = 1;
      if (csiPrefix === '' && csiIntermediates === '') {
        switch (String.fromCharCode(code)) {
          case 'S':
          case 'T':
          case 'L':
          case 'M':
            commandWork += TERMINAL_FULL_GRID_WORK + firstParameter;
            break;
          case 'J':
          case 'K':
            commandWork += TERMINAL_ROW_MUTATION_WORK;
            break;
          case '@':
          case 'P':
            commandWork += TERMINAL_ROW_MUTATION_WORK + firstParameter;
            break;
          case 'I':
          case 'Z':
            commandWork += firstParameter * (defaultTabStopsCleared ? TERMINAL_FULL_GRID_WORK : 1);
            break;
          case 'X':
          case 'b':
            commandWork += firstParameter;
            break;
        }
      } else if (
        csiPrefix === '' &&
        ((csiIntermediates === ' ' && (code === 0x40 || code === 0x41)) ||
          (csiIntermediates === "'" && (code === 0x7d || code === 0x7e)))
      ) {
        commandWork += TERMINAL_ROW_MUTATION_WORK + firstParameter;
      } else if (csiPrefix === '?' && csiIntermediates === '' && (code === 0x4a || code === 0x4b)) {
        // DECSED/DECSEL inspect protection metadata across the dense row even
        // when few cells change, unlike the ordinary erase fast path.
        commandWork += TERMINAL_ROW_MUTATION_WORK;
      } else if (csiPrefix === '?' && csiIntermediates === '' && (code === 0x68 || code === 0x6c)) {
        // DECSET/DECRST alternate-buffer switches clear/allocate a dense row.
        commandWork +=
          csiParameters.filter(
            (parameter) => parameter === 47 || parameter === 1047 || parameter === 1049,
          ).length * TERMINAL_FULL_GRID_WORK;
      }
      if (!spendWork(commandWork)) {
        return { safe: false, controlledCodeUnits: raw.length, parameterWork, repeatCodeUnits };
      }
      state = 'ground';
      resetCsi();
      precedingGraphicRun = 0;
    } else {
      state = 'csiIgnore';
      resetCsi();
    }
  }
  return { safe: true, controlledCodeUnits: raw.length, parameterWork, repeatCodeUnits };
}

type TerminalParserBoundaryState =
  | 'ground'
  | 'escape'
  | 'escapeIntermediate'
  | 'csi'
  | 'osc'
  | 'dcs'
  | 'sosPmApc';

interface TerminalRenderGroup {
  lines: Array<TerminalRenderLine>;
  inputCodeUnits: number;
  requiresTerminal: boolean;
}

type TerminalLineEnding = NonNullable<BuildLogLine['lineEnding']>;

interface TerminalRenderLine {
  raw: string;
  lineEnding: TerminalLineEnding;
}

const LINE_ENDING_TEXT: Record<TerminalLineEnding, string> = {
  cr: '\r',
  lf: '\n',
  crlf: '\r\n',
  none: '',
};

type TerminalLogInput = string | { line: string; lineEnding?: TerminalLineEnding | null };

function normalizeTerminalLogLines(lines: Array<TerminalLogInput>): Array<TerminalRenderLine> {
  return lines.map((entry, index) => {
    const capturedEnding = typeof entry === 'string' ? undefined : entry.lineEnding;
    const validCapturedEnding =
      capturedEnding === 'cr' ||
      capturedEnding === 'lf' ||
      capturedEnding === 'crlf' ||
      capturedEnding === 'none'
        ? capturedEnding
        : undefined;
    return {
      raw: typeof entry === 'string' ? entry : entry.line,
      // Old agents/rows did not preserve delimiters. Retain the previous CRLF
      // reconstruction between records while avoiding a fabricated trailing EOL.
      lineEnding: validCapturedEnding ?? (index + 1 < lines.length ? 'crlf' : 'none'),
    };
  });
}

/**
 * Track only VT parser framing across captured-row boundaries. Rendering stays
 * xterm's job; this state exists so the tail budget never cuts into the middle
 * of OSC/DCS/SOS/PM/APC, ESC, or CSI and then feeds its payload to a fresh
 * terminal as printable text.
 *
 * The transitions mirror xterm 6's VT500 table. DCS's entry/parameter/
 * passthrough states are deliberately collapsed: they all remain non-ground
 * until an anywhere transition or terminator, which is the only distinction
 * grouping needs. Invalid bytes may therefore keep a group open longer than
 * xterm would, but never close one early and expose hidden payload.
 */
function advanceTerminalParserBoundary(
  initialState: TerminalParserBoundaryState,
  raw: string,
): TerminalParserBoundaryState {
  let state = initialState;
  for (let index = 0; index < raw.length; index++) {
    const code = raw.charCodeAt(index);

    // VT500 anywhere transitions. The named C1 introducers override the
    // generic C1 execute-to-ground ranges below.
    if (code === 0x18 || code === 0x1a || code === 0x9c) {
      state = 'ground';
      continue;
    }
    if (code === 0x1b) {
      state = 'escape';
      continue;
    }
    if (code === 0x90) {
      state = 'dcs';
      continue;
    }
    if (code === 0x98 || code === 0x9e || code === 0x9f) {
      state = 'sosPmApc';
      continue;
    }
    if (code === 0x9b) {
      state = 'csi';
      continue;
    }
    if (code === 0x9d) {
      state = 'osc';
      continue;
    }
    if ((code >= 0x80 && code <= 0x97) || code === 0x99 || code === 0x9a) {
      state = 'ground';
      continue;
    }

    switch (state) {
      case 'ground':
        break;
      case 'escape':
        if (code <= 0x1f || code === 0x7f) {
          break;
        }
        if (code === 0x5b) {
          state = 'csi';
        } else if (code === 0x5d) {
          state = 'osc';
        } else if (code === 0x50) {
          state = 'dcs';
        } else if (code === 0x58 || code === 0x5e || code === 0x5f) {
          state = 'sosPmApc';
        } else if (code >= 0x20 && code <= 0x2f) {
          state = 'escapeIntermediate';
        } else if (code >= 0x30 && code <= 0x7e) {
          state = 'ground';
        }
        break;
      case 'escapeIntermediate':
        if (code <= 0x1f || code === 0x7f || (code >= 0x20 && code <= 0x2f)) {
          break;
        }
        if (code >= 0x30 && code <= 0x7e) {
          state = 'ground';
        }
        break;
      case 'csi':
        // C0 controls execute without ending CSI; parameters/intermediates and
        // DEL remain inside it. A final byte returns to ground.
        if (code >= 0x40 && code <= 0x7e) {
          state = 'ground';
        }
        break;
      case 'osc':
        // OSC alone accepts BEL as a terminator. ESC/CAN/SUB/ST were handled by
        // the anywhere transitions above.
        if (code === 0x07) {
          state = 'ground';
        }
        break;
      case 'dcs':
      case 'sosPmApc':
        // Their payload, including BEL and CR/LF, remains hidden until an
        // anywhere transition above aborts or terminates the string.
        break;
    }
  }
  return state;
}

/** Partition chronological rows without cutting VT state or a bare-CR rewrite. */
function groupTerminalLogLines(lines: Array<TerminalLogInput>): Array<TerminalRenderGroup> {
  const groups: Array<TerminalRenderGroup> = [];
  let state: TerminalParserBoundaryState = 'ground';
  let current: TerminalRenderGroup | null = null;
  const normalized = normalizeTerminalLogLines(lines);

  for (let index = 0; index < normalized.length; index++) {
    const line = normalized[index];
    if (current === null) {
      current = { lines: [], inputCodeUnits: 0, requiresTerminal: false };
    }
    current.lines.push(line);
    current.inputCodeUnits += line.raw.length + LINE_ENDING_TEXT[line.lineEnding].length;
    current.requiresTerminal ||=
      hasTerminalControl(line.raw) ||
      line.lineEnding === 'cr' ||
      (line.lineEnding === 'lf' && index + 1 < normalized.length) ||
      (line.lineEnding === 'none' && index + 1 < normalized.length);

    state = advanceTerminalParserBoundary(state, line.raw);
    state = advanceTerminalParserBoundary(state, LINE_ENDING_TEXT[line.lineEnding]);

    // A bare CR rewrites the same terminal row, so it remains in this atomic
    // group even at parser ground. LF/CRLF and EOF complete a logical row only
    // once every spanning parser sequence has returned to ground.
    if (
      state === 'ground' &&
      line.lineEnding !== 'cr' &&
      (line.lineEnding !== 'none' || index + 1 === normalized.length)
    ) {
      groups.push(current);
      current = null;
    }
  }

  if (current !== null) {
    groups.push(current);
  }
  return groups;
}

function preflightTerminalGroup(group: TerminalRenderGroup): TerminalPreflight {
  if (!group.requiresTerminal) {
    return { safe: true, controlledCodeUnits: 0, parameterWork: 0, repeatCodeUnits: 0 };
  }
  const controlledCodeUnits = group.inputCodeUnits;
  if (controlledCodeUnits > TERMINAL_RENDER_MAX_INPUT_CODE_UNITS) {
    return {
      safe: false,
      controlledCodeUnits,
      parameterWork: 0,
      repeatCodeUnits: 0,
    };
  }
  // Captured endings participate in parser state (notably resetting REP's
  // preceding grapheme), but their count is independently capped at 100. The
  // preflight serializer represents them as CR so raw in-record LF/VT/FF/C1
  // scroll controls still spend the hostile grid-work budget.
  const preflight = preflightTerminalInput(
    serializeTerminalGroupsForPreflight([group]),
    TERMINAL_RENDER_MAX_INPUT_CODE_UNITS,
  );
  return {
    safe: preflight.safe,
    controlledCodeUnits,
    parameterWork: preflight.parameterWork,
    repeatCodeUnits: preflight.repeatCodeUnits,
  };
}

function serializeTerminalGroups(groups: Array<TerminalRenderGroup>): string {
  return groups
    .flatMap((group) =>
      group.lines.map((line) => `${line.raw}${LINE_ENDING_TEXT[line.lineEnding]}`),
    )
    .join('');
}

/**
 * Preserve parser/REP boundaries without treating the at-most-100 captured
 * delimiters as hostile full-grid controls. A CR executes in the same ESC/CSI
 * states and resets REP's preceding graphic, but does not scroll xterm's row.
 */
function serializeTerminalGroupsForPreflight(groups: Array<TerminalRenderGroup>): string {
  return groups
    .flatMap((group) =>
      group.lines.map((line) => `${line.raw}${line.lineEnding === 'none' ? '' : '\r'}`),
    )
    .join('');
}

async function renderTerminalGroups(groups: Array<TerminalRenderGroup>): Promise<Array<string>> {
  if (groups.every((group) => !group.requiresTerminal)) {
    return groups.flatMap((group) =>
      group.lines.flatMap((line) => {
        const visible = line.raw.trimEnd();
        return visible === '' ? [] : [visible];
      }),
    );
  }

  const normalLines: Array<string> = [];
  const alternateLines: Array<string> = [];
  const term = new Terminal({
    cols: TERMINAL_RENDER_COLUMNS,
    rows: 1,
    allowProposedApi: true,
    // One scrollback row lets onLineFeed copy a completed row without retaining
    // the whole 32K x 100 tail grid. Memory remains constant.
    scrollback: 1,
  });
  let captureRecordedLineFeed = false;
  const lineFeed = term.onLineFeed(() => {
    // Line-motion controls inside one captured record keep the single-row
    // sanitizer semantics. Only an exact captured LF/CRLF completes a log row.
    if (!captureRecordedLineFeed) {
      return;
    }
    const buffer = term.buffer.active;
    const visible = (
      buffer.getLine(Math.max(0, buffer.baseY - 1))?.translateToString(false) ?? ''
    ).trimEnd();
    if (visible !== '') {
      if (buffer.type === 'alternate') {
        // The alternate buffer has no scrollback. With the one-row model, a
        // completed alternate row is gone after the scroll; only the final
        // active row can be visible when formatting finishes in this buffer.
        alternateLines.length = 0;
      } else {
        normalLines.push(visible);
      }
    }
  });
  // External row capture must follow xterm history clears. Returning false lets
  // xterm's built-in handler run after this observation hook.
  const clearCapturedHistory = (): boolean => {
    normalLines.length = 0;
    alternateLines.length = 0;
    return false;
  };
  const ris = term.parser.registerEscHandler({ final: 'c' }, clearCapturedHistory);
  const ed3 = term.parser.registerCsiHandler({ final: 'J' }, (params) => {
    if (params[0] === 3) {
      if (term.buffer.active.type === 'alternate') {
        alternateLines.length = 0;
      } else {
        normalLines.length = 0;
      }
    }
    return false;
  });
  const decsed3 = term.parser.registerCsiHandler({ prefix: '?', final: 'J' }, (params) => {
    if (params[0] === 3) {
      if (term.buffer.active.type === 'alternate') {
        alternateLines.length = 0;
      } else {
        normalLines.length = 0;
      }
    }
    return false;
  });
  try {
    for (const group of groups) {
      for (const line of group.lines) {
        await new Promise<void>((resolve) => term.write(line.raw, resolve));
        const ending = LINE_ENDING_TEXT[line.lineEnding];
        if (ending !== '') {
          captureRecordedLineFeed = line.lineEnding === 'lf' || line.lineEnding === 'crlf';
          try {
            await new Promise<void>((resolve) => term.write(ending, resolve));
          } finally {
            captureRecordedLineFeed = false;
          }
        }
      }
    }
    const buffer = term.buffer.active;
    const active = (buffer.getLine(buffer.baseY)?.translateToString(false) ?? '').trimEnd();
    const visibleLines = buffer.type === 'alternate' ? alternateLines : normalLines;
    if (active !== '') {
      visibleLines.push(active);
    }
    return visibleLines;
  } finally {
    decsed3.dispose();
    ed3.dispose();
    ris.dispose();
    lineFeed.dispose();
    term.dispose();
  }
}

/**
 * Render one captured log line through the same maintained VT engine used by
 * VS Code. A token parser is insufficient here: correctness depends on screen
 * state (cursor, tab stops, protected cells, wide glyphs, REP, and erase modes),
 * which is exactly the terminal emulator's job.
 *
 * Input is untrusted. xterm correctly bounds mutations to its configured grid,
 * but some handlers loop or allocate from raw numeric parameters. The deterministic
 * preflight above bounds those paths before allocation; an unsafe row is omitted
 * rather than risking resource exhaustion or resurrecting text a terminal erased.
 */
export async function sanitizeLogLineForMarkdown(raw: string): Promise<string> {
  // Nearly every captured line is ordinary text. It cannot mutate terminal
  // state, so avoid constructing a grid or yielding through the write queue.
  if (!hasTerminalControl(raw)) {
    return raw.trimEnd();
  }
  const preflight = preflightTerminalInput(raw);
  if (!preflight.safe) {
    return '';
  }
  const term = new Terminal({
    cols: TERMINAL_RENDER_COLUMNS,
    rows: 1,
    allowProposedApi: true,
    scrollback: 0,
  });
  try {
    await new Promise<void>((resolve) => term.write(raw, resolve));
    const buffer = term.buffer.active;
    return (buffer.getLine(buffer.baseY)?.translateToString(false) ?? '').trimEnd();
  } finally {
    term.dispose();
  }
}
/**
 * Render the check-run `output.text` log tail: `lines` (already chronological —
 * the newest CHECK_RUN_LOG_TAIL_LINES captured) in a `text` fence under a
 * `**Last {M} log lines:**` header, with an `_…earlier lines omitted._` marker
 * whenever fewer lines are rendered than `totalCaptured`. The fence delimiters
 * are max(6, longest backtick run in the kept content + 1) — a log line can
 * never close the fence, so raw (attacker-influenced) build output cannot
 * escape the code block into check-run markdown. Byte-capped at
 * CHECK_RUN_LOG_TAIL_MAX_BYTES (UTF-8 — GitHub validates bytesize): the
 * OLDEST remaining line is dropped while the joined content exceeds the cap;
 * a single still-over-cap line keeps its LAST bytes (the tail is what a
 * failure diagnosis wants), never cutting a surrogate pair in half. The WHOLE
 * rendered string is then forced under CHECK_RUN_OUTPUT_TEXT_MAX_BYTES the
 * same way (oldest-drop, then lone-line tail-truncation), because the dynamic
 * fence can outgrow the headroom the content cap budgeted for. Returns null
 * when nothing was captured (`text` is then omitted from the PATCH).
 *
 * Captured rows are first grouped at VT parser ground-state boundaries and each
 * group is reduced to terminal-visible text through one persistent xterm
 * parser. Lines that were pure control output drop out entirely. Rendering runs
 * BEFORE the byte accounting below, so every cap is measured against the bytes
 * actually sent to GitHub — a spinner line holding hundreds of erased frames
 * must not spend the tail's budget on output no reader will ever see.
 * The stored newest-100-row window is the explicit terminal reset boundary:
 * state older than that bounded capture is unavailable. Within the window we
 * never restart after an omitted state-mutating group; that case fails closed.
 */
export async function formatLogTailMarkdown(
  lines: Array<TerminalLogInput>,
  totalCaptured: number,
): Promise<string | null> {
  // Joined UTF-8 byte length = sum(line byte lengths) + (n - 1) one-byte '\n'
  // separators; dropping the oldest removes its bytes + one separator. Tracked
  // incrementally (no O(n²) joins).
  //
  // Select one contiguous suffix newest-first, then render it chronologically
  // through one xterm. Parser ground ends sequence framing, not persistent
  // terminal modes (tab stops, protection, charsets, saved cursor), so restarting
  // xterm per group is incorrect. Once an unsafe/over-budget group is reached,
  // stop: hopping across it would invent terminal state for the later suffix.
  const groups = groupTerminalLogLines(lines.slice(-CHECK_RUN_LOG_TAIL_LINES));
  const selectedNewestFirst: Array<TerminalRenderGroup> = [];
  let renderInputCodeUnits = 0;
  let requiresTerminal = false;
  let selectedStart = groups.length;
  for (let index = groups.length - 1; index >= 0; index--) {
    const group = groups[index];
    const preflight = preflightTerminalGroup(group);
    if (!preflight.safe) {
      break;
    }
    const nextRequiresTerminal: boolean = requiresTerminal || group.requiresTerminal;
    const nextRenderInputCodeUnits = renderInputCodeUnits + group.inputCodeUnits;
    if (nextRequiresTerminal) {
      if (nextRenderInputCodeUnits > TERMINAL_TAIL_MAX_INPUT_CODE_UNITS) {
        break;
      }
      // Re-preflight the candidate suffix as one chronological xterm session.
      // This carries tab-stop and mode state across parser-ground groups and
      // accumulates REP/handler work across the same lifetime that will render.
      const candidateGroups = [group, ...selectedNewestFirst.slice().reverse()];
      if (
        !preflightTerminalInput(
          serializeTerminalGroupsForPreflight(candidateGroups),
          TERMINAL_TAIL_MAX_INPUT_CODE_UNITS,
        ).safe
      ) {
        break;
      }
    }
    selectedNewestFirst.push(group);
    selectedStart = index;
    renderInputCodeUnits = nextRenderInputCodeUnits;
    requiresTerminal = nextRequiresTerminal;
  }
  if (selectedNewestFirst.length === 0) {
    return null;
  }
  // Starting a fresh terminal after an omitted state-mutating group can expose
  // text that the full session erased (custom tab stops, charset, protection,
  // insert mode, etc.). Plain omitted rows are harmless; an omitted controlled
  // prefix makes the later screen state unknowable, so fail closed.
  if (groups.slice(0, selectedStart).some((group) => group.requiresTerminal)) {
    return null;
  }
  const visibleLines = await renderTerminalGroups(selectedNewestFirst.reverse());

  // Apply the user-visible byte cap newest-first after terminal rendering. This
  // keeps at most the final 60KB plus one currently considered row live.
  const keptNewestFirst: Array<string> = [];
  let joinedBytes = 0;
  for (let lineIndex = visibleLines.length - 1; lineIndex >= 0; lineIndex--) {
    let visible = visibleLines[lineIndex];
    let visibleBytes = utf8Length(visible);
    if (keptNewestFirst.length === 0 && visibleBytes > CHECK_RUN_LOG_TAIL_MAX_BYTES) {
      while (visibleBytes > CHECK_RUN_LOG_TAIL_MAX_BYTES) {
        visible = sliceTailAtUnit(
          visible,
          Math.ceil((visibleBytes - CHECK_RUN_LOG_TAIL_MAX_BYTES) / 3),
        );
        visibleBytes = utf8Length(visible);
      }
      keptNewestFirst.push(visible);
      joinedBytes = visibleBytes;
      break;
    }
    const separatorBytes = keptNewestFirst.length > 0 ? 1 : 0;
    if (joinedBytes + separatorBytes + visibleBytes > CHECK_RUN_LOG_TAIL_MAX_BYTES) {
      break;
    }
    keptNewestFirst.push(visible);
    joinedBytes += separatorBytes + visibleBytes;
  }

  const kept = keptNewestFirst.reverse();
  if (kept.length === 0) {
    return null;
  }
  // Lone still-over-cap line: keep its LAST <= cap bytes. Bytes don't map 1:1
  // to code units, so converge: one dropped unit removes at most 3 bytes (the
  // largest UTF-8 encoding of a single UTF-16 code unit — a surrogate PAIR is
  // 4 bytes but 2 units), so a step of ceil(overflow / 3) never drops more
  // units than could possibly be needed; each dropped unit removes at least
  // 1 byte and the loop re-measures, so it terminates.
  while (kept.length === 1 && joinedBytes > CHECK_RUN_LOG_TAIL_MAX_BYTES) {
    kept[0] = sliceTailAtUnit(kept[0], Math.ceil((joinedBytes - CHECK_RUN_LOG_TAIL_MAX_BYTES) / 3));
    joinedBytes = utf8Length(kept[0]);
  }
  const render = (): string => {
    const fence = '`'.repeat(Math.max(6, Math.max(...kept.map(longestBacktickRun)) + 1));
    const parts = [`**Last ${kept.length} log lines:**`, ''];
    if (totalCaptured > kept.length) {
      parts.push('_…earlier lines omitted._', '');
    }
    parts.push(`${fence}text`, kept.join('\n'), fence);
    return parts.join('\n');
  };
  // Whole-string invariant (see CHECK_RUN_OUTPUT_TEXT_MAX_BYTES): shrink the
  // content — same rules as the content cap above — and re-derive the fence
  // until the fully-rendered string fits GitHub's bytesize cap. Content
  // shrinks every pass, so this terminates.
  let rendered = render();
  let renderedBytes = utf8Length(rendered);
  while (renderedBytes > CHECK_RUN_OUTPUT_TEXT_MAX_BYTES) {
    if (kept.length > 1) {
      kept.shift();
    } else {
      // One front code unit dropped shrinks the render by at most 5 BYTES:
      // at most 3 content bytes (the largest UTF-8 encoding of one code unit)
      // plus at most 2 fence bytes (the longest backtick run shrinks by at
      // most 1, taking one one-byte backtick off each of the two delimiters).
      // So a step of ceil(overflowBytes / 5) never drops more units than
      // could possibly be needed — never over-truncates the tail — while each
      // dropped unit still removes at least 1 byte (and the fence can only
      // shrink), so the re-measuring loop converges without a per-unit pass.
      const overflow = renderedBytes - CHECK_RUN_OUTPUT_TEXT_MAX_BYTES;
      kept[0] = sliceTailAtUnit(kept[0], Math.ceil(overflow / 5));
    }
    rendered = render();
    renderedBytes = utf8Length(rendered);
  }
  return rendered;
}

type StoredBuildStatus =
  | 'queued'
  | 'starting'
  | 'building'
  | 'deploying'
  | 'complete'
  | 'failed'
  | 'cancelled';

/** Stored build config plus the live status we track inside the DO. */
type ManagerState = BuildConfig & { status: StoredBuildStatus };

/**
 * Per-build DO (keyed by build id) that runs one build inside a Cloudflare
 * Container, streams the container's logs to attached WebSocket consumers,
 * enforces a wall-clock timeout, and writes every status transition back to
 * Postgres via Hyperdrive.
 *
 * The container runs the real `void deploy` CLI (see PR 8's build agent) with a
 * short-lived project-scoped `VOID_TOKEN`, so the platform's deploy endpoint is
 * unchanged. This DO never dispatches to user workers — DO→container,
 * DO→Hyperdrive, and DO→`api.github.com` are all allowed here.
 */
export class BuildManager extends Container<ApiEnv['Bindings']> {
  // Container config — the agent listens on 4000 and needs egress (tarball
  // download, npm install, deploy upload). `sleepAfter` is an IDLE timeout (a
  // safety-net that stops a stuck/orphaned container with no activity), NOT a
  // wall-clock cap and NOT renewed after start. The per-build wall-clock cap is
  // `enforceTimeout` (armed in startBuild). sleepAfter is sized above the hard
  // max (see SLEEP_AFTER_MINUTES) so it can never stop a legitimately running
  // build before enforceTimeout fires.
  override defaultPort = 4000;
  override enableInternet = true;
  override sleepAfter = `${SLEEP_AFTER_MINUTES}m`;

  // In-memory fallback for the just-created check-run id, set in startBuild right
  // after createCheckRun. The durable sources are DO storage + `builds.check_run_id`,
  // but if BOTH best-effort persists fail the id lives only here — and the terminal
  // finalizers (onStop/onError/enforceTimeout) are SEPARATE invocations with no
  // access to startBuild's local variable. This field survives create→terminal within
  // the build's lifetime (the DO is actively running the container), so finalize can
  // still PATCH the run. Strictly additive: consulted only behind explicitId/DO/PG,
  // and lost on eviction leaves behavior identical to today (no-op). The DO is keyed
  // per build, so there is no cross-build staleness.
  private activeCheckRunId: string | null = null;

  // Cursor for the DO→container log pull-loop: the highest agent `seq` already
  // ingested. `pollLogs` requests `GET /logs?since=logCursor` and advances it to
  // the response's `lastSeq`. In-memory ONLY (NOT persisted to ctx.storage):
  // exactly one build runs per DO and there is no restart-resume — a fresh DO
  // starts at 0 and replays from the agent's buffer, and the agent's own ring is
  // the source of truth, so a persisted cursor would add no correctness and only
  // risk skipping unbuffered lines after an eviction.
  private logCursor = 0;
  private logTableReady = false;

  private db(): Db {
    return createDb(this.env.HYPERDRIVE.connectionString);
  }

  private async getConfig(): Promise<ManagerState | null> {
    return (await this.ctx.storage.get<ManagerState>(STORAGE_KEY_CONFIG)) ?? null;
  }

  private async setStatus(status: StoredBuildStatus): Promise<void> {
    const state = await this.getConfig();
    if (state) {
      await this.ctx.storage.put<ManagerState>(STORAGE_KEY_CONFIG, { ...state, status });
    }
  }

  /**
   * Entry point invoked over RPC by the BuildScheduler. Persists the config,
   * mints the scoped deploy + installation tokens, starts the container with
   * the build env vars, and arms the timeout alarm.
   *
   * The DB row is already `starting` — the scheduler's `claimBuildForStartWithinLimit`
   * flipped it `queued -> starting` before calling us, so there is NO post-start
   * `starting` write here: a delayed `onStart` (which the base `start()` runs
   * inside `blockConcurrencyWhile` before resolving) or a fast-exit `onStop`
   * could already have moved the row to `building`/terminal, and re-writing
   * `starting` afterward would clobber it. `onStart` lands the `instance_type`
   * (the only place it is persisted) via a `starting`-guarded CAS.
   */
  async startBuild(config: BuildConfig): Promise<void> {
    await this.ctx.storage.put<ManagerState>(STORAGE_KEY_CONFIG, {
      ...config,
      status: 'starting',
    });

    // Token mint + container start can throw *before* the timeout alarm is
    // armed. At that point neither onError nor onStop will ever fire (those only
    // run after the container is live), so without this catch the row would be
    // stuck `starting` with no alarm and no reaper — permanently consuming one
    // of the user's concurrency slots. Fail it the same way onError does so the
    // slot is freed and the queue scan is re-armed, then re-throw.
    //
    // The catch also covers the step AFTER a successful `this.start()` (arming
    // the timeout schedule). That runs before onStop's reaper is reliably
    // wired, so a throw there would mark the row failed +
    // free the slot while the container keeps running the real `void deploy`
    // CLI with a live token — publishing a deployment for a build Postgres calls
    // `failed`. Track whether start() succeeded so the catch can best-effort
    // stop() the container before finalizing. A pre-start throw (token mint)
    // must NOT stop() — nothing was started.
    let containerStarted = false;
    try {
      // Just-in-time branch-head freshness recheck BEFORE any token mint / start.
      // The push webhook checks freshness at ENQUEUE, but a missed/delayed
      // newer-push webhook can leave a stale queued build that the scheduler runs
      // and publishes. Mirror the OIDC path's gate: prove the commit is still the
      // branch head before minting VOID_TOKEN. `getBranchHeadComparisonStatus`
      // returns null (never throws) on API failure, so a transient outage drives
      // the requeue/age-fail path below rather than the catch's fail.
      const headComparison = await getBranchHeadComparisonStatus(
        this.env,
        config.installationId,
        config.repoFullName,
        config.commitSha,
        config.branch,
      );
      if (headComparison === null) {
        // Can't verify (GitHub API down / repo inaccessible). Do NOT mint or start.
        // Bounce the row back to 'queued' (guarded, so a concurrent cancel wins) and
        // let the next alarm retry — UNLESS the build has been waiting too long, in
        // which case fail it so a persistent-null can't loop forever (no container is
        // started here, so nothing would ever reap it).
        const row = await getBuild(this.db(), config.buildId);
        const ageMs = row?.created_at ? Date.now() - new Date(row.created_at).getTime() : 0;
        if (ageMs > FRESHNESS_VERIFY_MAX_AGE_MS) {
          const won = await markBuildTerminalIfActive(this.db(), config.buildId, 'failed', {
            error: 'could not verify branch head is current before timeout',
            completedAt: new Date().toISOString(),
          });
          await this.setStatus('failed');
          await this.broadcast({ type: 'status', status: 'failed' });
          // Finalize a run created on a PRIOR attempt (a capacity requeue re-runs
          // startBuild on the same build id; the persisted `builds.check_run_id`
          // survives the requeue). No-ops on a first attempt (no run yet).
          // CAS-aware (mirrors the catch site below + the 6 terminal sites): the
          // awaits above (getBranchHeadComparisonStatus) release the DO input gate,
          // so a concurrent terminalizer (terminateBuildsForProject commits an
          // out-of-band terminal status, then the cancelBuild RPC) can win the row
          // with a DIFFERENT status. PATCH 'failure' only when THIS site won the CAS;
          // on a loss finalize to the recorded outcome so GitHub never contradicts
          // the authoritative DB row.
          if (won) {
            await this.finalizeCheckRunToStatus(config, 'failed');
          } else {
            await this.finalizeCheckRunToRecordedOutcome(config);
          }
        } else {
          await requeueBuildIfStarting(this.db(), config.buildId);
        }
        await this.pokeScheduler();
        return;
      }
      if (headComparison !== 'identical') {
        // ahead/behind/diverged → the commit is no longer the branch head (superseded
        // or rolled back / force-pushed away). Cancel; do NOT mint or start.
        const won = await markBuildTerminalIfActive(this.db(), config.buildId, 'cancelled', {
          error: 'commit is no longer the branch head',
          completedAt: new Date().toISOString(),
        });
        await this.setStatus('cancelled');
        await this.broadcast({ type: 'status', status: 'cancelled' });
        // Finalize a run created on a PRIOR attempt (see the aged-out branch above).
        // CAS-aware (see the aged-out branch): on a lost CAS finalize to the recorded
        // outcome so GitHub never contradicts the authoritative DB row.
        if (won) {
          await this.finalizeCheckRunToStatus(config, 'cancelled');
        } else {
          await this.finalizeCheckRunToRecordedOutcome(config);
        }
        await this.pokeScheduler();
        return;
      }
      // else 'identical' → proceed to the coverage recheck + signDeployToken + start.

      // Just-in-time GitHub App installation coverage recheck BEFORE any token
      // mint / start. The enqueue path (`installationCoversRepoInTx`) verified
      // coverage at build CREATE, but this DO mints the deploy + source tokens
      // LATER — after a queue wait that can be seconds to ~30min under capacity
      // backoff. If an uninstall / App-suspension / repo-removal webhook is
      // delivered in that window, the `github_installations` row is updated but
      // the enqueue-time check is stale. A fresh plain (non-locking) Postgres
      // read here observes the committed revocation and fails closed before we
      // mint a live deploy token, rather than relying solely on the installation
      // token mint failing once its ~55-min cache expires. A null repositoryId
      // (unprovable membership) fails closed by construction. Treat an
      // uncovered build like the non-identical freshness branch: cancel (not a
      // build failure), don't mint or start. Nothing is started yet, so there is
      // no container to tear down.
      const covered = await installationCoversRepo(
        this.db(),
        config.installationId,
        config.repositoryId,
      );
      if (!covered) {
        const won = await markBuildTerminalIfActive(this.db(), config.buildId, 'cancelled', {
          error: 'github app installation no longer covers this repository',
          completedAt: new Date().toISOString(),
        });
        await this.setStatus('cancelled');
        await this.broadcast({ type: 'status', status: 'cancelled' });
        // Finalize a run created on a PRIOR attempt (see the aged-out branch above).
        // CAS-aware (see the aged-out branch): on a lost CAS finalize to the recorded
        // outcome so GitHub never contradicts the authoritative DB row.
        if (won) {
          await this.finalizeCheckRunToStatus(config, 'cancelled');
        } else {
          await this.finalizeCheckRunToRecordedOutcome(config);
        }
        await this.pokeScheduler();
        return;
      }

      // Just-in-time cancellation recheck BEFORE any token mint / start. The
      // scheduler claimed this row (`queued -> starting`) potentially seconds to
      // ~30min ago (capacity backoff); in that window a disconnect or a
      // branch/executor change could have cancelled the build out-of-band
      // (`terminateBuildsForProject` commits a terminal status, then the
      // cancelBuild RPC). The branch-head + coverage rechecks above don't catch a
      // direct cancellation, so without this we'd mint a live deploy token and
      // start the container for an already-cancelled build, burning capacity until
      // enforceTimeout. A plain READ COMMITTED read suffices — the canceller
      // commits before its RPC. Do NOT re-terminalize (the canceller already wrote
      // the terminal row); just sync the local status, poke, and return —
      // mirroring the non-identical freshness branch above.
      const row = await getBuild(this.db(), config.buildId);
      if (!row || row.status !== 'starting') {
        if (row && TERMINAL_STATUSES.includes(row.status)) {
          await this.setStatus(row.status);
          // Finalize a run created on a PRIOR attempt that this requeue is now
          // abandoning (out-of-band cancel during the queue wait). No-ops on a first
          // attempt (no run yet); on a requeue the id is in DO storage / builds row.
          await this.finalizeCheckRunToStatus(config, row.status);
        }
        await this.pokeScheduler();
        return;
      }

      // Create the GitHub Check Run now that EVERY pre-start recheck passed — this
      // build WILL start, so the run begins `in_progress`. BEST-EFFORT: a create
      // failure (returns null) must never fail or perturb the build. Two guards:
      //   (a) Idempotent reuse across requeue — a capacity-to-start error re-throws
      //       WITHOUT terminalizing, the scheduler re-queues, and startBuild re-runs
      //       on the SAME DO. We reuse the id from DO storage, or — if that best-effort
      //       cache write was lost — from the persisted `builds.check_run_id` on the
      //       `row` already read above, so a requeue never POSTs a SECOND `Void Build`
      //       run (which would orphan the first one `in_progress`).
      //   (b) SHA guard — config.commitSha is `build.commit_sha ?? ''`; a check-run
      //       POST with head_sha:'' is a guaranteed GitHub 422, so skip creation when
      //       the SHA is empty (no run to orphan; finalizers no-op on the absent id).
      // The DO-storage write is the input-gated source of truth for finalizers; the
      // Postgres write is best-effort (DO KV/DB awaits aren't input-gated). A transient
      // create failure returns null and is NOT stored, so a later requeue retries it.
      let checkRunId: string | null =
        (await this.ctx.storage.get<string>(STORAGE_KEY_CHECK_RUN)) ??
        this.activeCheckRunId ??
        row.check_run_id ??
        null;
      if (!checkRunId && config.commitSha) {
        checkRunId = await createCheckRun(this.env, config.installationId, config.repoFullName, {
          name: 'Void Build',
          headSha: config.commitSha,
          externalId: config.buildId,
          detailsUrl: this.projectUrl(config),
          title: 'Void build in progress',
          summary: `Building \`${config.branch}\` @ ${config.commitSha.slice(0, 7)}`,
        });
        if (checkRunId) {
          // Record the id in-memory FIRST — before the best-effort persists below — so
          // even if BOTH the DO put and the Postgres persist fail, a later terminal
          // finalizer (a separate invocation) can still recover it for this build.
          this.activeCheckRunId = checkRunId;
          // BEST-EFFORT cache of the run id. This put + the Postgres persist below
          // must NOT enter the outer build-start catch: a failure to cache check-run
          // metadata is not a build failure. If the DO-storage put rejects, the id is
          // lost for finalizers (they no-op on the absent id) but the build proceeds;
          // a later requeue re-runs createCheckRun (the idempotent reuse only kicks in
          // once the put succeeds), so this self-heals. Swallow + log, never rethrow.
          let cached = false;
          try {
            await this.ctx.storage.put<string>(STORAGE_KEY_CHECK_RUN, checkRunId);
            cached = true;
          } catch (err) {
            console.warn('startBuild: caching check_run_id in DO storage failed', err);
          }
          try {
            await setBuildCheckRunId(this.db(), config.buildId, checkRunId);
          } catch (err) {
            console.warn(
              cached
                ? 'startBuild: persisting check_run_id failed (DO cache retains it)'
                : 'startBuild: persisting check_run_id failed (DO cache also failed)',
              err,
            );
          }
        }

        // The createCheckRun fetch above yielded the DO input gate, so a cancelBuild
        // RPC could have terminalized this build mid-POST (its finalizeCheckRun ran
        // BEFORE the id was stored → no-op). Re-read the authoritative row: if it is no
        // longer 'starting', sync local status, finalize the just-created run to the
        // recorded outcome, and do NOT mint tokens / start a container. Mirrors the
        // pre-create cancel recheck above; runs only when a create POST happened.
        const recheck = await getBuild(this.db(), config.buildId);
        if (!recheck || recheck.status !== 'starting') {
          if (recheck && TERMINAL_STATUSES.includes(recheck.status)) {
            await this.setStatus(recheck.status);
            // Pass the in-hand `checkRunId`: the run was just created this invocation,
            // so this finalizes it even if both the DO put and the PG persist failed.
            await this.finalizeCheckRunToStatus(config, recheck.status, checkRunId);
          }
          await this.pokeScheduler();
          return;
        }
      }

      // Fail fast on a staging platform misconfiguration. Staging API hosts sit
      // behind CF Access and the container can't do the interactive cloudflared
      // flow, so it relies on the service-token pair being forwarded (below). If
      // staging is missing EITHER secret, the build would otherwise run all the
      // way through download/install/build and only fail at the Access edge when
      // `void deploy` calls the API — a confusing late failure that wastes a
      // container slot. Reject up front as a build failure with a clear message;
      // the catch finalizes it (failed + pokeScheduler) so the slot frees. The
      // pair is all-or-nothing: a half-configured pair is as broken as none.
      // Production isn't Access-gated, so this only applies on staging.
      if (
        this.env.PLATFORM_ENV === 'staging' &&
        !(this.env.CF_ACCESS_CLIENT_ID_STAGING && this.env.CF_ACCESS_CLIENT_SECRET_STAGING)
      ) {
        throw new Error(
          'staging build misconfigured: CF_ACCESS_CLIENT_ID_STAGING and CF_ACCESS_CLIENT_SECRET_STAGING must both be set on the staging API worker so the build can reach the Access-gated staging API',
        );
      }

      // Size the deploy token to cover the whole build (mint happens *before*
      // download + install + deploy). `timeoutMinutes: 0` means unlimited
      // wall-clock, so the shared helper falls back to the hard max; otherwise
      // it uses the plan timeout. Either way the minutes are capped at the hard
      // max so even an "unlimited" custom plan can't mint an unbounded-life
      // token, then padded with a fixed margin so the token outlives the build.
      const ttlSeconds = deployTokenTtlSecondsForBuildMinutes(config.timeoutMinutes);
      const voidToken = await signDeployToken(
        {
          projectId: config.projectId,
          userId: config.userId,
          login: config.login,
          buildId: config.buildId,
        },
        this.env.JWT_SECRET,
        { ttlSeconds },
      );
      // Repo-scope the source token to the ONE repo being built, read-only. The
      // build agent uses it solely as the Bearer to download this repo's tarball,
      // but it's injected into the container env where an untrusted dependency
      // `postinstall` could read it — a repo-scoped `{ contents: 'read' }` token
      // caps that blast radius to this single repo instead of every repo the
      // install covers. A null repositoryId (legacy/partial connection) can't be
      // scoped, so fall back to the unscoped installation-wide mint to preserve
      // compatibility; coverage is already re-verified above.
      const sourceToken =
        config.repositoryId !== null
          ? await getInstallationToken(this.env, config.installationId, {
              repositoryIds: [config.repositoryId],
              permissions: { contents: 'read' },
            })
          : await getInstallationToken(this.env, config.installationId);
      const sourceTarballUrl = generateSourceTarballUrl(config.repoFullName, config.commitSha);
      const voidApiUrl =
        this.env.PLATFORM_ENV === 'staging'
          ? 'https://api.staging.void.cloud'
          : 'https://api.void.cloud';

      // Staging API hosts sit behind CF Access; the `void deploy` child can't do
      // the interactive `cloudflared` flow (no TTY/binary in the container), so
      // forward the staging service-token pair under the names the CLI reads
      // (`CF_ACCESS_CLIENT_ID`/`SECRET`). Production isn't Access-gated, so this
      // only applies on staging and only when the secrets are configured. These
      // are scrubbed from untrusted install children and re-injected only into
      // the trusted deploy child by the build-agent (see `SCRUBBED_ENV_VARS`).
      const stagingAccess: Record<string, string> =
        this.env.PLATFORM_ENV === 'staging' &&
        this.env.CF_ACCESS_CLIENT_ID_STAGING &&
        this.env.CF_ACCESS_CLIENT_SECRET_STAGING
          ? {
              CF_ACCESS_CLIENT_ID: this.env.CF_ACCESS_CLIENT_ID_STAGING,
              CF_ACCESS_CLIENT_SECRET: this.env.CF_ACCESS_CLIENT_SECRET_STAGING,
            }
          : {};

      // Per-build, unguessable agent secret. The agent (parent process) presents
      // it on its control POSTs (/logs, /status, /cancel); the DO rejects any
      // request without it. The build-agent scrubs AGENT_TOKEN (along with
      // DO_LOG_URL/SOURCE_TOKEN) out of the env handed to untrusted repo
      // install/build child processes, so a malicious postinstall can't forge
      // build status even if it discovers the DO endpoint.
      const agentToken = crypto.randomUUID();
      await this.ctx.storage.put<string>(STORAGE_KEY_AGENT_TOKEN, agentToken);

      // Real Container env-var mechanism: set `this.envVars` then start(). The
      // base class forwards these into the container's `start({ env })` call.
      this.envVars = {
        BUILD_ID: config.buildId,
        PROJECT_ID: config.projectId,
        PROJECT_SLUG: config.projectSlug,
        SOURCE_TARBALL_URL: sourceTarballUrl,
        SOURCE_TOKEN: sourceToken,
        VOID_TOKEN: voidToken,
        VOID_API_URL: voidApiUrl,
        VOID_PROJECT: config.projectSlug,
        VOID_CLI_VERSION: PINNED_VOID_CLI_VERSION,
        DO_LOG_URL: 'https://manager/logs',
        AGENT_TOKEN: agentToken,
        // Commit/source metadata for `void deploy`. The extracted tarball has no
        // `.git`, so the CLI's `getGitCommit` would record a NULL commit — leaving
        // the deployment unlinked (onStop's getDeploymentByProjectAndCommit can't
        // match) and breaking same-SHA redelivery dedup. The CLI reads GITHUB_SHA
        // FIRST (before any git inspection — this is exactly how the GitHub Actions
        // executor stamps it), and GITHUB_REPOSITORY/GITHUB_REF feed the source
        // links, so forwarding these stamps the deployment correctly. They're the
        // build's own commit/repo/branch (non-secret), and NOT scrubbed from the
        // untrusted child env — the repo already knows its own identity.
        GITHUB_SHA: config.commitSha,
        GITHUB_REPOSITORY: config.repoFullName,
        GITHUB_REF: `refs/heads/${config.branch}`,
        ...stagingAccess,
      };

      // Flip the marker BEFORE awaiting start(): the base `start()` launches the
      // container (`startContainerIfNotRunning`) and THEN runs
      // `blockConcurrencyWhile(() => this.onStart())` before it resolves, so a
      // throw from our `onStart` (its `markBuildBuildingIfStarting` is a
      // Hyperdrive/Postgres write that can throw transiently) rejects start()
      // AFTER the container is already live. If the marker only flipped on the
      // line after a resolved start(), that onStart-reject would be treated as a
      // pre-launch failure and the catch would skip teardown, leaving the
      // container running the real `void deploy` CLI with a live token while
      // Postgres records the build `failed` — pinning a global fleet slot until
      // the idle net. A genuine pre-launch throw still can't stop a non-existent
      // container: the capacity error originates in `startContainerIfNotRunning`
      // BEFORE any launch and the catch re-throws it before the stop block, and
      // token-mint throws happen above this line with the marker still false.
      containerStarted = true;
      await this.start();

      // Wall-clock timeout. Use the base Container's public scheduler instead of
      // writing the DO alarm directly: a DO has a SINGLE alarm and the base
      // Container OWNS it to drive its monitor loop (polling container state and
      // dispatching onStop on exit). Overwriting that alarm with our own wake
      // time would starve the base loop, so onStop might never fire and a
      // healthy build could never finalize. `schedule()` stores a row the base
      // alarm loop invokes when due, calling our `enforceTimeout` callback
      // without disturbing the base cadence.
      //
      // A timeout is ALWAYS armed, even for a custom "unlimited" plan
      // (`timeoutMinutes: 0`): the base `sleepAfter` idle-stop never fires for a
      // busy container, so without this an orphaned build could run far past any
      // sane ceiling. 0 falls back to the hard max; a positive plan timeout is
      // capped at it. Mirrors `deployTokenTtlSecondsForBuildMinutes`, so the
      // build can never outlive its deploy token.
      const effectiveTimeout =
        config.timeoutMinutes > 0
          ? Math.min(config.timeoutMinutes, DEPLOY_TOKEN_HARD_MAX_MINUTES)
          : DEPLOY_TOKEN_HARD_MAX_MINUTES;
      await this.schedule(effectiveTimeout * 60, 'enforceTimeout');
    } catch (error) {
      if (isContainerCapacityError(error)) {
        // Capacity-to-start (fleet full), not a build failure. Nothing was started
        // (containerStarted is false here), so there's nothing to stop. Leave the row
        // as the scheduler claimed it and re-throw so the scheduler catch requeues it.
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      // Mirror enforceTimeout / cancelBuild: set the LOCAL terminal status FIRST
      // (DO storage — can't fail on Hyperdrive) so the onStop that the teardown
      // below triggers sees the terminal status and won't clobber it, THEN tear
      // the container down. If the container already launched, a throw here (the
      // onStart-reject inside start(), or schedule arming) must force it down
      // before we finalize as failed — otherwise it keeps running the real
      // `void deploy` CLI with a live token while Postgres says `failed`, pinning
      // a fleet slot until the idle net. `forceStopContainer` SIGTERMs THEN
      // SIGKILLs (idempotent / TERMINAL-safe) so a SIGTERM-ignoring build agent
      // can't outlive the failure; `stop()` alone is SIGTERM-only. Best-effort so
      // a teardown failure doesn't mask the original error.
      await this.setStatus('failed');
      if (containerStarted) {
        await this.forceStopContainer();
      }
      // CAS terminal-if-active (NOT an unconditional write): a concurrent cancel
      // (terminateBuildsForProject commits 'cancelled' out-of-band, then the
      // cancelBuild RPC) can have already driven this row terminal. An
      // unconditional updateBuildStatus('failed') would clobber that 'cancelled'
      // to 'failed'; the CAS no-ops on an already-terminal row (the slot is
      // already freed). The DB write + broadcast run inside a try whose `finally`
      // ALWAYS pokes the scheduler — mirroring onStop/onError/enforceTimeout — so a
      // transient Hyperdrive/Postgres throw on the terminal write can't skip the
      // queue re-arm and strand the slot until the stale reaper.
      try {
        const won = await markBuildTerminalIfActive(this.db(), config.buildId, 'failed', {
          error: message,
          completedAt: new Date().toISOString(),
        });
        await this.broadcast({ type: 'status', status: 'failed' });
        // Finalize the check-run here too: the run is created BEFORE signDeployToken /
        // this.start() / the staging-misconfig check, so a throw in that window marks
        // the build `failed` HERE and no onStop ever finalizes it (force-stop →
        // onStop's terminal-status guard no-op). Without this the run is stranded
        // `in_progress` forever. The capacity-error branch re-throws above and never
        // reaches here, so the requeued build correctly keeps its run `in_progress`.
        // CAS-aware: only PATCH 'failure' when THIS site won the terminal transition.
        // On a lost CAS (the row was terminalized out-of-band, e.g. a concurrent
        // cancel) read the authoritative row and finalize to ITS outcome, so GitHub
        // never contradicts the DB.
        if (won) {
          await this.finalizeCheckRun(config, 'failure', {
            detailsUrl: this.projectUrl(config),
            title: 'Void build failed',
            summary: message,
          });
        } else {
          await this.finalizeCheckRunToRecordedOutcome(config);
        }
      } finally {
        await this.pokeScheduler();
      }
      throw error;
    }
  }

  /**
   * The project's public traffic URL — used as the check-run `details_url`. Staging
   * and production serve user traffic on different base domains (`staging.void.app`
   * vs `void.app`), so the link must be env-aware: read the per-environment
   * `SITE_DOMAIN` binding (the same source the deploy-URL output uses), falling back
   * to the production constant when unset.
   */
  private projectUrl(config: BuildConfig): string {
    return `https://${config.projectSlug}.${this.env.SITE_DOMAIN ?? SITE_DOMAIN}`;
  }

  /**
   * Finalize this build's GitHub Check Run with a terminal conclusion. BEST-EFFORT:
   * resolves the run id from, in order, an explicit in-hand id → the in-memory
   * `activeCheckRunId` → input-gated DO storage → the persisted `builds.check_run_id`,
   * so a DO-storage miss (eviction, a rejected cache put, a transient loss) OR a dual
   * persist failure cannot strand an already-created run `in_progress`. No-ops when no
   * source has an id (no run was created, or create failed), and never throws so the
   * caller's `finally { pokeScheduler() }` always runs. `completeCheckRun` already
   * swallows internally; the extra try/catch is belt-and-suspenders.
   */
  private async finalizeCheckRun(
    config: BuildConfig,
    conclusion: CheckRunConclusion,
    opts: { detailsUrl?: string; title: string; summary: string },
    explicitId?: string | null,
  ): Promise<void> {
    // Prefer the in-hand id, then the in-memory field (survives create→terminal within
    // the build's lifetime), then the durable sources. The first two are authoritative
    // even when BOTH the DO-storage put and the Postgres persist failed.
    let checkRunId =
      explicitId ??
      this.activeCheckRunId ??
      (await this.ctx.storage.get<string>(STORAGE_KEY_CHECK_RUN));
    if (!checkRunId) {
      // DO storage missed — recover the id from Postgres (written by
      // `setBuildCheckRunId` at create). Best-effort: a read failure leaves the id
      // unknown and the run unfinalized (cosmetic), never throwing out of finalize.
      try {
        checkRunId = (await getBuild(this.db(), config.buildId))?.check_run_id ?? undefined;
      } catch (err) {
        console.warn('finalizeCheckRun: builds.check_run_id fallback read failed', err);
      }
    }
    if (!checkRunId) {
      return;
    }
    // Embed the stored log tail as the run's `output.text` — BEST-EFFORT: a
    // SQLite read failure must not block the completion PATCH (the run
    // completes without `text`, exactly the pre-tail body).
    let text: string | undefined;
    try {
      text = (await this.readLogTailMarkdown()) ?? undefined;
    } catch (err) {
      console.warn('finalizeCheckRun: log tail read failed (best-effort)', err);
    }
    try {
      await completeCheckRun(this.env, config.installationId, config.repoFullName, checkRunId, {
        conclusion,
        ...opts,
        ...(text ? { text } : {}),
      });
    } catch (err) {
      console.warn('finalizeCheckRun: best-effort PATCH failed', err);
    }
  }

  /**
   * Finalize the check-run to the AUTHORITATIVE build status — used on the rare
   * lost-CAS path (the row was terminalized out-of-band, e.g. an admin/disconnect
   * cancel) and the post-create cancellation recheck. Maps the DB's terminal
   * status to its check-run conclusion so GitHub always matches the recorded
   * outcome instead of this site's assumed one. No-ops (returns) for a non-terminal
   * status; delegates to `finalizeCheckRun`, which itself no-ops on an absent id
   * and never throws.
   */
  private async finalizeCheckRunToStatus(
    config: BuildConfig,
    status: string,
    explicitId?: string | null,
  ): Promise<void> {
    const conclusion =
      status === 'complete'
        ? 'success'
        : status === 'cancelled'
          ? 'cancelled'
          : status === 'failed'
            ? 'failure'
            : null;
    if (!conclusion) {
      return;
    }
    await this.finalizeCheckRun(
      config,
      conclusion as CheckRunConclusion,
      {
        detailsUrl: this.projectUrl(config),
        title: `Void build ${conclusion === 'success' ? 'succeeded' : conclusion}`,
        summary: `Build ${status}.`,
      },
      explicitId,
    );
  }

  /**
   * Lost-CAS finalize: read the AUTHORITATIVE build status and finalize the check-run
   * to it. Used at every terminal site when `markBuildTerminalIfActive` lost (the row
   * was terminalized out-of-band). BEST-EFFORT — the `getBuild` is wrapped so a
   * transient read failure logs and returns instead of throwing out of the terminal
   * handler (which would skip the PATCH AND propagate); the slot is freed regardless
   * by the caller's `finally { pokeScheduler() }`.
   */
  private async finalizeCheckRunToRecordedOutcome(config: BuildConfig): Promise<void> {
    let status: string | undefined;
    try {
      status = (await getBuild(this.db(), config.buildId))?.status;
    } catch (err) {
      console.warn('finalizeCheckRunToRecordedOutcome: getBuild failed (best-effort)', err);
      return;
    }
    if (status) {
      await this.finalizeCheckRunToStatus(config, status);
    }
  }

  override async onStart(): Promise<void> {
    const config = await this.getConfig();
    if (!config) {
      return;
    }
    // CAS `starting -> building` and land the `instance_type` (its only persist
    // point — the scheduler's claim set `starting` without it). The base
    // `start()` runs onStart inside `blockConcurrencyWhile` before resolving, so
    // a fast-exit `onStop` can have already driven the row terminal; this guard
    // is the authoritative protection against resurrecting it. Only sync the
    // in-memory status (used by the other lifecycle guards) when the CAS won, so
    // a no-op onStart can't downgrade an already-terminal in-memory status.
    const moved = await markBuildBuildingIfStarting(this.db(), config.buildId, {
      instanceType: config.instanceType,
    });
    if (!moved) {
      return;
    }
    await this.setStatus('building');
    await this.broadcast({ type: 'status', status: 'building' });
    // Start the DO→container log pull-loop once the container is live and the row
    // is `building`. First tick fires soon (1s); `pollLogs` re-arms itself on the
    // POLL_SECONDS cadence and self-terminates when the build goes terminal. Armed
    // via the SAME base scheduler as `enforceTimeout` (never a raw setAlarm — the
    // base Container owns the single DO alarm for its monitor loop + onStop).
    await this.schedule(1, 'pollLogs');
  }

  override async onStop(params: {
    exitCode: number;
    reason: 'exit' | 'runtime_signal';
  }): Promise<void> {
    const config = await this.getConfig();
    if (!config) {
      return;
    }

    const current = config.status;
    if (TERMINAL_STATUSES.includes(current)) {
      // Already finalized (e.g. timeout alarm fired and stopped the container).
      // Don't overwrite the recorded outcome; just poke the scheduler.
      await this.pokeScheduler();
      return;
    }

    const db = this.db();
    const completedAt = new Date().toISOString();
    // Mirror enforceTimeout / cancelBuild: set the LOCAL terminal status FIRST
    // (DO storage — can't fail on Hyperdrive), then run the Postgres terminal
    // write + broadcast inside a try whose `finally` ALWAYS pokes the scheduler.
    // `markBuildTerminalIfActive` has no internal try/catch, so a transient
    // Postgres throw here must NOT skip pokeScheduler() — otherwise the row would
    // stay ACTIVE and pin the concurrency slot until the 75m idle reaper even
    // though the container has already exited (and, on exit 0, the deploy is
    // live). The container already exited, so there is no stop() to make.
    if (params.exitCode === 0) {
      await this.setStatus('complete');
      try {
        // The deployment link is BEST-EFFORT and must run inside this try. The
        // lookup is a Hyperdrive/Postgres read that can throw on a transient
        // error AFTER `void deploy` already exited 0; if it threw outside the
        // try (as it used to), `onStop` would reject before `setStatus` and the
        // `finally`, leaving the build row ACTIVE with no scheduler poke — the
        // deploy live but the concurrency slot pinned until the 75m idle reaper.
        // Swallow the lookup error and finalize 'complete' with a null link
        // instead; the row is still terminalized and the slot freed.
        let deploymentId: string | null = null;
        try {
          const deployment = await getDeploymentByProjectAndCommit(
            db,
            config.projectId,
            config.commitSha,
          );
          deploymentId = deployment?.id ?? null;
        } catch (err) {
          console.error('onStop: deployment lookup failed; finalizing without link', err);
        }
        // CAS terminal-if-active: the in-memory guard above is defense in depth;
        // this is the authoritative check against clobbering an outcome a
        // concurrent terminal write (e.g. the timeout) already recorded in the DB.
        const won = await markBuildTerminalIfActive(db, config.buildId, 'complete', {
          exitCode: 0,
          completedAt,
          deploymentId,
        });
        await this.broadcast({ type: 'status', status: 'complete' });
        // CAS-aware finalize: only PATCH 'success' when THIS exit-0 won the terminal
        // transition. On a lost CAS (the row was terminalized out-of-band first, e.g.
        // an admin cancel committed 'cancelled') finalizing 'success' would contradict
        // the DB. Read the authoritative row and finalize to ITS recorded outcome so
        // GitHub matches the DB. `details_url` comes from `projectSlug` (already in
        // hand) so a deployment lookup miss does NOT cost the link.
        if (won) {
          await this.finalizeCheckRun(config, 'success', {
            detailsUrl: this.projectUrl(config),
            title: 'Void build succeeded',
            summary: deploymentId ? 'Deployment is live.' : 'Build complete.',
          });
        } else {
          await this.finalizeCheckRunToRecordedOutcome(config);
        }
      } finally {
        await this.pokeScheduler();
      }
    } else {
      await this.setStatus('failed');
      try {
        const won = await markBuildTerminalIfActive(db, config.buildId, 'failed', {
          error: `build exited with code ${params.exitCode} (${params.reason})`,
          exitCode: params.exitCode,
          completedAt,
        });
        await this.broadcast({ type: 'status', status: 'failed' });
        // CAS-aware: finalize 'failure' only when THIS site won; otherwise finalize to
        // the out-of-band recorded outcome so GitHub matches the DB.
        if (won) {
          await this.finalizeCheckRun(config, 'failure', {
            detailsUrl: this.projectUrl(config),
            title: 'Void build failed',
            summary: `Build exited with code ${params.exitCode}.`,
          });
        } else {
          await this.finalizeCheckRunToRecordedOutcome(config);
        }
      } finally {
        await this.pokeScheduler();
      }
    }
  }

  override async onError(error: unknown): Promise<void> {
    const config = await this.getConfig();
    if (!config) {
      return;
    }
    if (TERMINAL_STATUSES.includes(config.status)) {
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    // Mirror onStop / enforceTimeout / cancelBuild: set the LOCAL terminal status
    // FIRST (DO storage — can't fail on Hyperdrive), then run the Postgres terminal
    // write + broadcast inside a try whose `finally` ALWAYS pokes the scheduler.
    // `markBuildTerminalIfActive` has no internal try/catch, so a transient
    // Postgres throw here must NOT skip pokeScheduler() — otherwise the row stays
    // ACTIVE and pins the concurrency slot until the 75m idle reaper even though
    // the container has already errored.
    await this.setStatus('failed');
    try {
      const won = await markBuildTerminalIfActive(this.db(), config.buildId, 'failed', {
        error: message,
        completedAt: new Date().toISOString(),
      });
      await this.broadcast({ type: 'status', status: 'failed' });
      // CAS-aware: finalize 'failure' only when THIS site won; otherwise finalize to
      // the out-of-band recorded outcome so GitHub matches the DB.
      if (won) {
        await this.finalizeCheckRun(config, 'failure', {
          detailsUrl: this.projectUrl(config),
          title: 'Void build failed',
          summary: message,
        });
      } else {
        await this.finalizeCheckRunToRecordedOutcome(config);
      }
    } finally {
      await this.pokeScheduler();
    }
  }

  /**
   * Force the container down on a timeout/cancel path. `stop()` only sends a
   * SIGTERM — which the agent (PID 1) now handles cooperatively — but a wedged or
   * adversarial child (e.g. a `postinstall` that blocks uninterruptibly or
   * ignores SIGTERM) can survive it, and `@cloudflare/containers` never escalates
   * to SIGKILL on its own. So follow the best-effort SIGTERM with `destroy()`
   * (SIGKILL), which a PID-1 process cannot mask. Without the escalation a hung
   * build keeps running and permanently pins one of the fleet's global
   * `max_instances` slots — capacity starvation across every tenant, since the
   * STALE reaper only re-cancels rows still ACTIVE (this row is already terminal).
   *
   * Both calls are best-effort + idempotent: the build is already recorded
   * terminal locally, so neither a no-op stop()/destroy() on an already-exited
   * container nor a transient teardown error must propagate past here. `destroy()`
   * triggers onStop, whose TERMINAL_STATUSES guard makes it a safe no-op (it only
   * pokes the scheduler).
   */
  private async forceStopContainer(): Promise<void> {
    try {
      await this.stop();
    } catch {
      // Best-effort SIGTERM — the build is already recorded terminal locally.
    }
    try {
      await this.destroy();
    } catch {
      // Best-effort SIGKILL — container already gone / mid-teardown.
    }
  }

  /**
   * Wall-clock build timeout, invoked by the base Container's alarm loop when
   * the schedule armed in `startBuild` comes due (NOT an `alarm()` override —
   * the base owns the single DO alarm to drive its container monitor + onStop
   * dispatch, so we MUST NOT hijack it). Force-stops the container and fails the
   * build. `stop()` ultimately triggers onStop, which sees the terminal status
   * set here and won't clobber it.
   *
   * Public + named so the base scheduler can resolve it as a callback. Takes the
   * scheduler's `(payload, schedule)` args (unused here).
   */
  async enforceTimeout(): Promise<void> {
    const config = await this.getConfig();
    if (!config || TERMINAL_STATUSES.includes(config.status)) {
      return;
    }
    // Set the LOCAL terminal status first (DO storage — can't fail on Hyperdrive)
    // so onStop, triggered by the teardown below, sees the terminal status and
    // won't clobber it. Container teardown + the scheduler poke are then made
    // INDEPENDENT of the Postgres terminal write: `markBuildTerminalIfActive` has
    // no internal try/catch, so a Hyperdrive/Postgres throw must NOT skip
    // forceStopContainer() (leaving a timed-out container running with a
    // still-honored deploy token + a pinned fleet slot) or pokeScheduler()
    // (stranding the freed concurrency slot). forceStopContainer SIGTERMs then
    // SIGKILLs so a SIGTERM-ignoring build can't outlive its timeout.
    await this.setStatus('failed');
    await this.forceStopContainer();
    try {
      const won = await markBuildTerminalIfActive(this.db(), config.buildId, 'failed', {
        error: 'build timed out',
        completedAt: new Date().toISOString(),
      });
      await this.broadcast({ type: 'status', status: 'failed' });
      // CAS-aware: finalize 'failure' only when THIS site won; otherwise finalize to
      // the out-of-band recorded outcome so GitHub matches the DB.
      if (won) {
        await this.finalizeCheckRun(config, 'failure', {
          detailsUrl: this.projectUrl(config),
          title: 'Void build failed',
          summary: 'build timed out',
        });
      } else {
        await this.finalizeCheckRunToRecordedOutcome(config);
      }
    } finally {
      // Free the slot even if the DB write (or broadcast) threw.
      await this.pokeScheduler();
    }
  }

  /**
   * Internal RPC cancel — invoked by the API (github.ts) when a project is
   * disconnected or its branch/executor changes, orphaning this build. Trusted
   * DO→DO / API→DO path (like startBuild), so NO agent secret is required; the
   * agent-authenticated POST /cancel path stays for the in-container agent.
   *
   * Mirrors enforceTimeout's teardown but with a cancel outcome, using the CAS
   * (`markBuildTerminalIfActive`) so it can't clobber an outcome a concurrent
   * onStop/timeout already recorded. Idempotent: a no-op once the build is
   * already terminal. Best-effort stop() then pokes the scheduler so the freed
   * concurrency slot is reclaimed.
   */
  async cancelBuild(reason = 'build cancelled'): Promise<void> {
    const config = await this.getConfig();
    const shouldTerminalize = config != null && !TERMINAL_STATUSES.includes(config.status);
    // Set the LOCAL terminal status first (DO storage — can't fail on Hyperdrive)
    // so onStop, triggered by stop() below, sees the terminal status and won't
    // clobber it. Only when the build isn't already terminal — a late cancel
    // against an already-finalized row must NOT downgrade the recorded outcome.
    if (shouldTerminalize) {
      await this.setStatus('cancelled');
    }
    // Container teardown is UNCONDITIONAL and independent of the Postgres write:
    // `markBuildTerminalIfActive` has no internal try/catch, so a Hyperdrive
    // throw must NOT skip forceStopContainer() (leaving the orphaned container
    // running + a pinned fleet slot) or pokeScheduler() (stranding the freed
    // slot). forceStopContainer SIGTERMs then SIGKILLs (idempotent) so a
    // SIGTERM-ignoring orphan can't survive the cancel.
    await this.forceStopContainer();
    try {
      if (shouldTerminalize) {
        const won = await markBuildTerminalIfActive(this.db(), config.buildId, 'cancelled', {
          error: reason,
          completedAt: new Date().toISOString(),
        });
        await this.broadcast({ type: 'status', status: 'cancelled' });
        // Only when terminalizing: a late cancel against an already-terminal row must
        // not re-PATCH and clobber the recorded outcome. `config` is non-null here
        // (shouldTerminalize requires config != null). CAS-aware: finalize 'cancelled'
        // only when THIS site won; otherwise finalize to the out-of-band recorded
        // outcome so GitHub matches the DB.
        if (won) {
          await this.finalizeCheckRun(config, 'cancelled', {
            detailsUrl: this.projectUrl(config),
            title: 'Void build cancelled',
            summary: reason,
          });
        } else {
          await this.finalizeCheckRunToRecordedOutcome(config);
        }
      }
    } finally {
      // Free the slot even if the DB write (or broadcast) threw.
      await this.pokeScheduler();
    }
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.headers.get('Upgrade') === 'websocket') {
      return this.handleWebSocketUpgrade();
    }
    // Admin log poll: a plain (no-Upgrade) `GET /logs?since=N` read of the stored
    // SQLite `logs` table. Branches AFTER the WS upgrade above so a GET WITH the
    // upgrade header still takes the WS path. DOs aren't publicly reachable — only
    // our worker holds the binding — so no token auth; this is strictly READ-ONLY
    // (no inserts, no status writes, no broadcast, no container fetch).
    if (request.method === 'GET' && path === '/logs') {
      return this.handleReadLogs(url);
    }
    // Agent control endpoints are authenticated with the per-build secret so a
    // malicious repo build step can't POST forged logs/status to the DO even if
    // it discovers the endpoint URL.
    if (request.method === 'POST' && (path === '/status' || path === '/cancel')) {
      if (!(await this.isAuthorizedAgent(request))) {
        return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
      }
      if (path === '/status') {
        return this.handleStatus(request);
      }
      return this.handleCancel();
    }

    // Anything else is forwarded to the container (health checks, etc.).
    return super.fetch(request);
  }

  /**
   * Constant-time check of the per-build agent secret presented on a control
   * request (`Authorization: Bearer <token>` or `X-Agent-Token`). Returns false
   * if no secret was minted yet (build not started) or it doesn't match.
   */
  private async isAuthorizedAgent(request: Request): Promise<boolean> {
    const expected = await this.ctx.storage.get<string>(STORAGE_KEY_AGENT_TOKEN);
    if (!expected) {
      return false;
    }
    const header = request.headers.get('Authorization');
    const presented =
      header && header.startsWith('Bearer ')
        ? header.slice('Bearer '.length)
        : (request.headers.get('X-Agent-Token') ?? '');
    return timingSafeEqual(presented, expected);
  }

  // --- log storage + fan-out ---

  private ensureLogTable(): void {
    if (this.logTableReady) {
      return;
    }
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS logs (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        line TEXT NOT NULL,
        stream TEXT NOT NULL,
        ts INTEGER NOT NULL,
        line_ending TEXT
      )`,
    );
    const columns = this.ctx.storage.sql
      .exec<{ name: string }>('PRAGMA table_info(logs)')
      .toArray();
    if (!columns.some((column) => column.name === 'line_ending')) {
      // Existing per-build DOs may have created the table before delimiter
      // provenance was stored. Keep those values NULL so the formatter can
      // reconstruct CRLF only BETWEEN legacy rows without fabricating an EOL
      // after the final row.
      this.ctx.storage.sql.exec('ALTER TABLE logs ADD COLUMN line_ending TEXT');
    }
    this.logTableReady = true;
  }

  /**
   * READ-ONLY poll read of the stored `logs` table for the admin worker.
   * `GET /logs?since=N` → `{ lines: Array<{seq,line,stream,ts}>, lastSeq, status,
   * terminal }` where `lines` are the rows with `seq > N` (ascending) and
   * `lastSeq` is the table's MAX(seq) — or the requested `since` when the table
   * is empty, so a poller's cursor never moves backward across an empty response
   * (same monotonic intent as `pollLogs`). A missing/non-numeric `since` is
   * treated as 0. No inserts, no status writes, no broadcast — this only reads
   * SQLite + DO storage.
   *
   * `status`/`terminal` are surfaced from the DO-local config (the authoritative
   * live status): every completion path sets the DO status terminal FIRST, then
   * does the Postgres CAS write — so if that PG write throws, the PG row can lag
   * ACTIVE until the stale reaper while the DO/container is already terminal.
   * Exposing the DO's terminal here lets `void build logs --follow` stop promptly
   * instead of polling for ~2h. `null`/`false` when no config exists yet.
   */
  private async handleReadLogs(url: URL): Promise<Response> {
    this.ensureLogTable();
    const raw = Number(url.searchParams.get('since'));
    const since = Number.isFinite(raw) ? raw : 0;
    const lines = this.ctx.storage.sql
      .exec<{ seq: number; line: string; stream: string; ts: number }>(
        'SELECT seq, line, stream, ts FROM logs WHERE seq > ? ORDER BY seq ASC',
        since,
      )
      .toArray();
    const maxRow = this.ctx.storage.sql
      .exec<{ max: number | null }>('SELECT MAX(seq) AS max FROM logs')
      .toArray()[0];
    const lastSeq = maxRow?.max ?? since;
    const cfg = await this.getConfig();
    return Response.json({
      lines,
      lastSeq,
      status: cfg?.status ?? null,
      terminal: cfg ? isTerminalBuildStatus(cfg.status) : false,
    });
  }

  /**
   * Assemble the check-run `output.text` log tail from the stored `logs` table:
   * the newest CHECK_RUN_LOG_TAIL_LINES rows (read newest-first, rendered
   * chronologically) plus the total captured count, so the omission marker can
   * say when earlier lines exist. Null when nothing was captured — the
   * completion PATCH then omits `text` (body identical to the pre-tail one).
   */
  private async readLogTailMarkdown(): Promise<string | null> {
    this.ensureLogTable();
    const rows = this.ctx.storage.sql
      .exec<{ line: string; lineEnding: TerminalLineEnding | null }>(
        'SELECT line, line_ending AS lineEnding FROM logs ORDER BY seq DESC LIMIT ?',
        CHECK_RUN_LOG_TAIL_LINES,
      )
      .toArray();
    const countRow = this.ctx.storage.sql
      .exec<{ count: number }>('SELECT COUNT(*) AS count FROM logs')
      .toArray()[0];
    return formatLogTailMarkdown(rows.reverse(), countRow?.count ?? rows.length);
  }

  /**
   * Persist a batch of log lines into the SQLite `logs` table (bounded to the
   * most-recent MAX_STORED_LOG_LINES rows) and fan each out over the WebSocket.
   * Fed ONLY by the DO→container pull-loop (`pollLogs`) — the single
   * authoritative transport for container output into the DO sink. (The agent
   * still POSTs to `DO_LOG_URL`, but that push has no route back to the DO, so
   * it never reaches here; the pull-loop is the sole producer.)
   */
  private async ingestLines(lines: ReadonlyArray<BuildLogLine>): Promise<void> {
    this.ensureLogTable();
    for (const entry of lines) {
      this.ctx.storage.sql.exec(
        'INSERT INTO logs (line, stream, ts, line_ending) VALUES (?, ?, ?, ?)',
        entry.line,
        entry.stream,
        entry.ts,
        entry.lineEnding ?? null,
      );
    }
    // Evict everything older than the most-recent MAX_STORED_LOG_LINES rows so the
    // table (and the WS replay that loads it) stays bounded for the build's
    // lifetime. `seq` is a monotonic AUTOINCREMENT, so the kept window is always
    // the contiguous tail; once-per-batch keeps this O(1) statements, not O(line).
    if (lines.length > 0) {
      this.ctx.storage.sql.exec(
        'DELETE FROM logs WHERE seq <= (SELECT MAX(seq) FROM logs) - ?',
        MAX_STORED_LOG_LINES,
      );
    }
    for (const entry of lines) {
      await this.broadcast({
        type: 'log',
        line: entry.line,
        stream: entry.stream,
        ts: entry.ts,
      });
    }
  }

  /**
   * DO→container log pull-loop. The agent buffers stdout/stderr and serves
   * `GET /logs?since=N` (`{ lines: Array<{seq,line,stream,ts,lineEnding?}>, lastSeq }`);
   * this method polls it, ingests any new lines (cursor-stripped), advances the
   * cursor to `lastSeq`, and re-arms itself — the only transport feeding container
   * output into the DO's store + WS fan-out. Public + named so the base scheduler can
   * resolve it as a callback (same mechanism as `enforceTimeout`); we MUST NOT
   * override `alarm()` (the base owns the single DO alarm).
   *
   * Self-terminating: returns WITHOUT re-arming once the build is gone or terminal
   * so the loop stops at completion. CRITICALLY, this uses a NON-STARTING fetch —
   * `this.container.getTcpPort(port).fetch(url)` — NOT `this.containerFetch(...)`.
   * `containerFetch` AUTO-STARTS a stopped container (its own internal
   * `container.running` re-check happens AFTER an `await getState()`, container.js:847),
   * so even with the `container.running` guard below a build that exits in the
   * guard→fetch TOCTOU window could be RESURRECTED — rerunning install/build/`void
   * deploy`. The raw port fetch is `containerFetch` MINUS that auto-start branch:
   * identical on a running/healthy container, but it FAILS (caught + swallowed)
   * instead of restarting an exited one, so a poll can never resurrect a finished
   * build. The `container.running` guard is kept purely as a cheap early-out for
   * the common already-exited case (it avoids a 1s busy-retry; onStop finalizes).
   * A transient fetch failure is swallowed and the loop re-arms to retry next tick.
   */
  async pollLogs(): Promise<void> {
    const config = await this.getConfig();
    if (!config || TERMINAL_STATUSES.includes(config.status)) {
      // No build, or the build finished — stop the loop (do NOT re-arm).
      return;
    }
    // The base copies `ctx.container` into a private field; read the same object via
    // a public-typed cast. We need both `running` (the cheap early-out below) and
    // `getTcpPort` (the NON-starting fetch path used in the try block).
    const container = (
      this as unknown as {
        container?: {
          running: boolean;
          getTcpPort(port: number): { fetch(url: string): Promise<Response> };
        };
      }
    ).container;
    // Common case: the container has already exited. Stop the loop (do NOT re-arm)
    // — onStop will finalize the build. Skips the fetch entirely.
    if (!container?.running) {
      return;
    }
    try {
      // NON-STARTING fetch. Unlike `this.containerFetch(...)`, `getTcpPort().fetch()`
      // does NOT auto-start a stopped container (containerFetch's auto-start branch,
      // container.js:847, is exactly what we must avoid here). So even if the
      // container exits in the TOCTOU window between the running guard above and this
      // call, the fetch FAILS (caught below) instead of RESURRECTING the just-finished
      // build — which would otherwise rerun install/build/`void deploy`. On a
      // running/healthy container this is identical to what containerFetch does after
      // its start check.
      const res = await container
        .getTcpPort(this.defaultPort)
        .fetch(`http://manager/logs?since=${this.logCursor}`);
      if (res.ok) {
        const body = (await res.json()) as {
          lines: Array<BuildLogLine & { seq: number }>;
          lastSeq: number;
        };
        if (body.lines.length > 0) {
          await this.ingestLines(
            body.lines.map(({ line, stream, ts, lineEnding }) => ({
              line,
              stream,
              ts,
              lineEnding,
            })),
          );
        }
        // Monotonic-advance: never move the cursor backward if a stale/empty
        // response reports a lower lastSeq than we've already ingested.
        this.logCursor = Math.max(this.logCursor, body.lastSeq);
      }
    } catch (err) {
      // Container gone / mid-start / transient — swallow and retry on the next tick.
      // Must NOT throw out of a scheduled callback.
      console.warn('pollLogs: container log fetch failed (will retry)', err);
    }
    // Re-arm. Reached on success AND on a swallowed fetch error (the container may
    // still be running and just briefly unreachable). The running guard above ends
    // the loop once the container is gone.
    await this.schedule(POLL_SECONDS, 'pollLogs');
  }

  private async handleStatus(request: Request): Promise<Response> {
    const body = (await request.json()) as { status?: StoredBuildStatus };
    const config = await this.getConfig();
    if (!body.status || !config) {
      return Response.json({ ok: false }, { status: 400 });
    }
    // The agent may only report *non-terminal* PROGRESS ('building'|'deploying').
    // Terminal outcomes (complete/failed/cancelled) are decided exclusively by
    // the trusted DO lifecycle — onStop (container exit code), the timeout
    // alarm, or an authenticated cancel — so a build step can never forge a
    // 'complete' that frees the slot while the container is still running.
    // Anything else (incl. 'queued'/'starting') is rejected so a buggy/malicious
    // agent can't write an arbitrary lifecycle state.
    if (body.status !== 'building' && body.status !== 'deploying') {
      return Response.json({ ok: false, error: 'status not allowed' }, { status: 400 });
    }
    // Don't let a late progress report clobber an already-finalized build (local
    // fast path; the CAS below is the authoritative cross-process guard).
    if (TERMINAL_STATUSES.includes(config.status)) {
      return Response.json({ ok: false, error: 'build already finalized' }, { status: 409 });
    }
    // Guarded CAS: only write the progress status while the DB row is still
    // active. A CAS-miss means a concurrent terminalizer (push-supersede,
    // disconnect, branch/executor change, app removal) already drove the row
    // terminal out-of-band while the DO's local status still said active. An
    // unconditional write here would resurrect that `cancelled` row to
    // 'deploying' and re-enable the bound deploy token, letting a superseded
    // runner publish stale code. On a CAS-miss, tear down via cancelBuild — its
    // own `markBuildTerminalIfActive` CAS no-ops against the already-terminal row
    // (NO clobber) and best-effort stop()s the orphaned container + pokes the
    // scheduler. Never write `cancelled` directly here (that reintroduces the
    // unguarded-write bug class).
    const moved = await markBuildProgressIfActive(this.db(), config.buildId, body.status);
    if (!moved) {
      await this.cancelBuild('build superseded');
      return Response.json({ ok: false, error: 'build no longer active' }, { status: 409 });
    }
    await this.setStatus(body.status);
    await this.broadcast({ type: 'status', status: body.status });
    return Response.json({ ok: true });
  }

  private async handleCancel(): Promise<Response> {
    // The agent-authenticated POST /cancel path shares the same teardown as the
    // internal RPC; delegate so the cancel outcome + CAS guard live in one place.
    await this.cancelBuild();
    return Response.json({ ok: true });
  }

  private handleWebSocketUpgrade(): Response {
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    // Hibernatable accept — the DO can sleep between log batches and still
    // receive the socket on wake.
    this.ctx.acceptWebSocket(server);

    // Replay every stored log line, then a caught-up marker, then the socket
    // live-streams subsequent broadcasts.
    this.ensureLogTable();
    const rows = this.ctx.storage.sql
      .exec<{ line: string; stream: string; ts: number }>(
        'SELECT line, stream, ts FROM logs ORDER BY seq ASC',
      )
      .toArray();
    for (const row of rows) {
      server.send(JSON.stringify({ type: 'log', line: row.line, stream: row.stream, ts: row.ts }));
    }
    server.send(JSON.stringify({ type: 'caught_up' }));

    return new Response(null, { status: 101, webSocket: client });
  }

  private async broadcast(message: Record<string, unknown>): Promise<void> {
    const payload = JSON.stringify(message);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(payload);
      } catch {
        // Dead socket — ignore; the runtime will surface a close event.
      }
    }
  }

  private async pokeScheduler(): Promise<void> {
    try {
      await this.env.BUILD_SCHEDULER.get(this.env.BUILD_SCHEDULER.idFromName('global')).fetch(
        'https://scheduler/poke',
        { method: 'POST' },
      );
    } catch {
      // Best-effort — the scheduler's own poke-on-next-webhook backstops this.
    }
  }
}

/**
 * Larger build container for paid plans. Identical behavior to BuildManager —
 * it exists only as a distinct container-enabled DO class so wrangler.jsonc can
 * bind it to a bigger static `instance_type` (standard-4). @cloudflare/containers
 * has no per-start sizing, so a second class is the only way to offer a second
 * container size. Routing (which class a build uses) is decided elsewhere by the
 * build's persisted instance_type.
 */
export class BuildManagerLarge extends BuildManager {}
