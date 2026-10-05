import {
  isCI,
  log,
  settings,
  spinner,
  type SpinnerOptions,
  type SpinnerResult,
} from '@voidzero-dev/vite-plus-prompts';
import pc from 'picocolors';

export { pc };

export function formatCount(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

/** Keep recovery commands on the same CLI when using the local checkout launcher. */
export function cliCommandName(): 'void' | 'void-dev' {
  const entryName = process.argv[1]?.split(/[\\/]/).at(-1);
  return entryName === 'void-dev' || entryName === 'void-dev.cmd' ? 'void-dev' : 'void';
}

/** Keep phase updates visible in static progress output, including redirected terminals. */
export function createSpinner(
  options?: Pick<SpinnerOptions, 'onCancel'>,
  isTerminal: boolean = process.stdout.isTTY === true,
): SpinnerResult {
  const accessible =
    settings?.accessible ?? ![undefined, '', '0', 'false'].includes(process.env.ACCESSIBLE);
  if (!isCI() && isTerminal && !accessible) {
    return spinner(options);
  }

  let currentMessage = '';
  let cancelled = false;
  return {
    start(msg = '') {
      currentMessage = msg;
      cancelled = false;
      if (msg) {
        log.step(msg);
      }
    },
    stop(msg = '') {
      if (msg) {
        log.info(msg);
      }
    },
    message(msg = '') {
      if (msg && msg !== currentMessage) {
        currentMessage = msg;
        log.step(msg);
      }
    },
    cancel(msg = '') {
      cancelled = true;
      if (msg) {
        log.warn(msg);
      }
    },
    error(msg = '') {
      if (msg) {
        log.error(msg);
      }
    },
    pause() {},
    resume(msg = '') {
      this.message(msg);
    },
    clear() {},
    get isCancelled() {
      return cancelled;
    },
  };
}

export function sectionTitle(title: string): string {
  return pc.reset(pc.blue(title));
}

export function categoryTitle(title: string): string {
  return pc.reset(pc.bold(title));
}

export function dim(text: string): string {
  return pc.dim(text);
}

export function tablePrefix(): string {
  return `${pc.gray('│')}  `;
}

/** Strip terminal control characters from text received from a platform. */
export function sanitizeTerminalText(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');
}

export function helpLine(command: string, description: string): string {
  return `${pc.reset(command.padEnd(34))} ${pc.dim(description)}`;
}

/**
 * Ensure a timestamp string will be parsed as UTC by `new Date()`.
 * DB timestamps lack timezone info — appends 'Z' only when no
 * existing indicator (Z, z, or numeric offset) is present.
 */
export function ensureUtc(s: string): string {
  const last = s.at(-1);
  if (last === 'Z' || last === 'z') {
    return s;
  }
  if (s.includes('+', 10)) {
    return s;
  }
  if (s.lastIndexOf('-') > 9) {
    return s;
  }
  return s + 'Z';
}
