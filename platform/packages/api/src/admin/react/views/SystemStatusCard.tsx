/** @jsxImportSource react */
import { Check, Minus, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useFateClient, useView, type ViewRef } from 'react-fate';
import { HealthView, healthRequest } from '../../fate/views.ts';
import { DashboardCard } from './DashboardCard.tsx';

const serviceLabels: Record<string, string> = {
  api: 'API',
  proxy: 'Proxy',
  dashboard: 'Dashboard',
  dispatch: 'Dispatch',
  db: 'Database',
};

function LastCheckedTime({ checkedAt, unavailable }: { checkedAt?: number; unavailable: boolean }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (checkedAt === undefined) {
      return;
    }
    setNow(Date.now());
    const interval = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(interval);
  }, [checkedAt]);
  const seconds = checkedAt === undefined ? 0 : Math.max(0, Math.floor((now - checkedAt) / 1000));
  const age =
    seconds < 5
      ? 'just now'
      : seconds < 60
        ? `${seconds}s ago`
        : `${Math.floor(seconds / 60)}m ago`;
  return (
    <span className="void-admin-health-checked-at" data-unavailable={unavailable || undefined}>
      {unavailable ? (
        <span role="status">Status unavailable</span>
      ) : checkedAt !== undefined ? (
        <time
          dateTime={new Date(checkedAt).toISOString()}
          title={new Date(checkedAt).toLocaleTimeString()}
        >
          Checked {age}
        </time>
      ) : null}
    </span>
  );
}

export function SystemStatusCard({ checkNames }: { checkNames: ReadonlyArray<string> }) {
  const client = useFateClient();
  const [healthRef, setHealthRef] = useState<ViewRef<'AdminHealth'> | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'unavailable'>('loading');
  const health = useView(HealthView, healthRef);
  useEffect(() => {
    let active = true;
    const retained = client.retain(healthRequest);
    const poll = async (mode: 'stale-while-revalidate' | 'network-only') => {
      try {
        const { health: ref } = await client.request(healthRequest, { mode });
        if (!ref) {
          throw new Error('Health data is unavailable.');
        }
        if (active) {
          setHealthRef(ref);
          setStatus('ready');
        }
      } catch {
        if (active) {
          setStatus('unavailable');
        }
      }
    };
    void poll('stale-while-revalidate');
    const interval = setInterval(() => void poll('network-only'), 30_000);
    return () => {
      active = false;
      clearInterval(interval);
      retained.dispose();
    };
  }, [client]);
  const checksByName = new Map(health?.checks.map((check) => [check.name, check]));
  return (
    <div id="health-status">
      <DashboardCard
        title="System Status"
        headerAccessory={
          <LastCheckedTime checkedAt={health?.checkedAt} unavailable={status === 'unavailable'} />
        }
      >
        <ul id="health-checks" className="void-admin-health-checks" aria-label="Service health">
          {checkNames.map((name) => {
            const label = serviceLabels[name] ?? name;
            const check = status === 'ready' ? checksByName.get(name) : undefined;
            const state =
              status === 'loading'
                ? 'loading'
                : !check
                  ? 'unavailable'
                  : check.ok
                    ? 'healthy'
                    : 'error';
            const detail =
              status !== 'ready'
                ? ''
                : !check
                  ? 'Unavailable'
                  : !check.ok
                    ? check.error || 'Health check failed.'
                    : '';
            const description =
              state === 'loading'
                ? 'Pending'
                : state === 'healthy'
                  ? 'Healthy'
                  : detail || 'Unavailable';
            const latency = check?.ok && check.latencyMs > 0 ? ` (${check.latencyMs}ms)` : '';
            return (
              <li
                key={name}
                className="void-admin-health-check"
                data-state={state}
                aria-label={`${label}: ${description}`}
                title={`${label}: ${description}${latency}`}
              >
                <span className="void-admin-health-indicator" aria-hidden="true">
                  {state === 'healthy' ? (
                    <Check size={16} />
                  ) : state === 'error' ? (
                    <X size={16} />
                  ) : state === 'unavailable' ? (
                    <Minus size={16} />
                  ) : null}
                </span>
                <span className="void-admin-health-label">{label}</span>
                {detail && <span className="void-admin-health-detail">{detail}</span>}
              </li>
            );
          })}
        </ul>
      </DashboardCard>
    </div>
  );
}
