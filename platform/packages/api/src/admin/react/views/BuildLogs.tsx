/** @jsxImportSource @voidcloud/api/admin-jsx */

import { useEffect, useRef, useState } from 'react';
import { useFateClient } from 'react-fate';
import { isTerminalBuildStatus } from '../../../build-status.ts';
import type { Build } from '../../../types.ts';
import {
  BuildLogsView,
  BuildStatusView,
  buildLogsRequest,
  buildStatusRequest,
} from '../../fate/views.ts';

export { isTerminalBuildStatus };

type LogLine = { seq: number; line: string; stream: string };
export function BuildLogs({ build }: { build: Build }) {
  const fate = useFateClient();
  const [lines, setLines] = useState<Array<LogLine> | null>(null);
  const pre = useRef<HTMLPreElement>(null);

  useEffect(() => {
    let active = true;
    let cursor = 0;
    let polling = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    setLines(null);

    const pollLogs = async () => {
      if (polling) {
        return;
      }
      polling = true;
      try {
        const { buildLogs: ref } = await fate.request(buildLogsRequest(build.id, cursor), {
          mode: 'network-only',
        });
        if (!ref) {
          return;
        }
        const { data } = (await fate.readView(BuildLogsView, ref)) as unknown as {
          data: { lines: Array<LogLine>; lastSeq: number };
        };
        if (!active) {
          return;
        }
        cursor = Math.max(cursor, data.lastSeq);
        setLines((current) => [...(current ?? []), ...data.lines]);
      } catch {
        // A later poll can recover from a transient log request failure.
      } finally {
        polling = false;
      }
    };

    const poll = async () => {
      await pollLogs();
      try {
        const { buildStatus: ref } = await fate.request(buildStatusRequest(build.id), {
          mode: 'network-only',
        });
        const status = ref
          ? ((await fate.readView(BuildStatusView, ref)) as unknown as {
              data: { terminal: boolean };
            })
          : null;
        if (status?.data.terminal) {
          clearInterval(timer);
          await pollLogs();
        }
      } catch {
        // Keep polling while the status probe is unavailable.
      }
    };

    void pollLogs();
    if (!isTerminalBuildStatus(build.status)) {
      timer = setInterval(() => void poll(), 2_000);
    }
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [build.id, build.status, fate]);

  useEffect(() => {
    const element = pre.current;
    if (element && element.scrollHeight - element.scrollTop - element.clientHeight < 40) {
      element.scrollTop = element.scrollHeight;
    }
  }, [lines]);

  return (
    <>
      <h2>Build Logs</h2>
      <pre
        ref={pre}
        id="build-log"
        style="min-height: 120px; max-height: 480px; overflow-y: auto; font-size: 0.78rem"
      >
        {lines === null
          ? 'Loading logs...'
          : lines.length === 0
            ? 'No logs yet.'
            : lines.map((line, index) => (
                <span
                  key={line.seq}
                  style={{ color: line.stream === 'stderr' ? '#dc2626' : 'inherit' }}
                >
                  {index > 0 && '\n'}
                  {line.line}
                </span>
              ))}
      </pre>
    </>
  );
}
