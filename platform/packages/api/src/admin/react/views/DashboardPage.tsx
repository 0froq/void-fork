/** @jsxImportSource @voidcloud/api/admin-jsx */
import { useEffect, useState } from 'react';
import type { Deployment } from '../../../types.ts';
import { DeploymentTable } from './DeploymentTable.tsx';
import { formatAbsoluteDateTime } from './format.ts';
import { Layout } from './Layout.tsx';
import type { ProjectRow } from './ProjectsTable.tsx';
import { ProjectsTable } from './ProjectsTable.tsx';

export type TopProjectRow = Readonly<{
  url?: string;
  id: string;
  user_id: string;
  slug: string;
  type: string;
  owner_login: string | null;
  requests: number;
  bandwidthBytes: number;
  lastSeen: string;
}>;

type DashboardProps = Readonly<{
  stats: {
    users: number;
    projects: number;
    deployments: number;
  };
  projects: ReadonlyArray<ProjectRow>;
  deployments: ReadonlyArray<Deployment & { project_slug: string | null }>;
  topProjects: ReadonlyArray<TopProjectRow>;
  siteDomain: string;
  platformName: string;
  username?: string;
}>;

function formatNumber(value: number) {
  return new Intl.NumberFormat('en-US').format(value);
}

function formatBytes(bytes: number) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unitIndex = -1;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unitIndex]}`;
}

function HealthStatusBanner() {
  type Health = {
    allOk: boolean;
    checks: Array<{ name: string; ok: boolean; latencyMs: number; error?: string }>;
  };
  const [health, setHealth] = useState<Health | 'loading' | 'unavailable'>('loading');
  useEffect(() => {
    let active = true;
    const poll = async () => {
      try {
        const response = await fetch('/admin/health', {
          credentials: 'same-origin',
          redirect: 'error',
        });
        if (!response.ok) {
          throw new Error('Health request failed');
        }
        const data = (await response.json()) as Health;
        if (!Array.isArray(data.checks)) {
          throw new Error('Invalid health response');
        }
        if (active) {
          setHealth(data);
        }
      } catch {
        if (active) {
          setHealth('unavailable');
        }
      }
    };
    void poll();
    const interval = setInterval(() => void poll(), 30_000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, []);
  const failed = typeof health === 'object' ? health.checks.filter((check) => !check.ok).length : 0;
  const summary =
    health === 'loading'
      ? 'Loading...'
      : health === 'unavailable'
        ? 'Unable to check system status'
        : health.allOk
          ? 'All health checks passed'
          : `${failed} health check${failed === 1 ? '' : 's'} failed`;
  const error = health === 'unavailable' || (typeof health === 'object' && !health.allOk);
  return (
    <div
      id="health-status"
      style={{ marginBottom: 20, padding: 12, border: `1px solid ${error ? '#ef4444' : '#ccc'}` }}
    >
      <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px">
        <strong>System Status</strong>
        <span
          id="health-summary"
          style={{
            fontSize: '0.8rem',
            color: error ? '#ef4444' : health === 'loading' ? '#666' : '#22c55e',
          }}
        >
          {summary}
        </span>
      </div>
      <div id="health-checks" style="display: flex; gap: 16px; flex-wrap: wrap">
        {typeof health === 'object' &&
          health.checks.map((check) => (
            <span key={check.name} style="font-size: 0.8rem">
              <span style={{ color: check.ok ? '#22c55e' : '#ef4444' }}>●</span> {check.name}
              {check.latencyMs > 0 ? ` (${check.latencyMs}ms)` : ''}
              {!check.ok && (
                <span style="color: #ef4444"> — {check.error || 'Health check failed.'}</span>
              )}
            </span>
          ))}
      </div>
    </div>
  );
}

function TopProjectsWidget({
  projects,
  siteDomain,
}: {
  projects: ReadonlyArray<TopProjectRow>;
  siteDomain: string;
}) {
  return (
    <div style="margin-top: 24px; padding: 12px; border: 1px solid #ccc">
      <div style="display: flex; align-items: baseline; justify-content: space-between; gap: 12px">
        <strong>Top 10 Projects</strong>
        <span style="font-size: 0.8rem; color: #666">
          Last hour, site traffic only (static / ssr / isr)
        </span>
      </div>
      {projects.length > 0 ? (
        <table style="margin-top: 10px">
          <thead>
            <tr>
              <th>#</th>
              <th>Project</th>
              <th>Owner</th>
              <th>Requests</th>
              <th>Bandwidth</th>
              <th>Last Seen</th>
            </tr>
          </thead>
          <tbody>
            {projects.map((project, index) => (
              <tr key={project.id}>
                <td>{index + 1}</td>
                <td>
                  <div>
                    <a href={`/admin/projects/${project.id}`}>{project.slug}</a>
                  </div>
                  <div style="font-size: 0.75rem; color: #666">
                    <a
                      href={project.url ?? `https://${project.slug}.${siteDomain}`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {project.url ?? `${project.slug}.${siteDomain}`}
                    </a>{' '}
                    · {project.type}
                  </div>
                </td>
                <td>
                  {project.owner_login ? (
                    <a href={`/admin/users/${project.user_id}`}>{project.owner_login}</a>
                  ) : (
                    '-'
                  )}
                </td>
                <td>{formatNumber(project.requests)}</td>
                <td>{formatBytes(project.bandwidthBytes)}</td>
                <td>{formatAbsoluteDateTime(project.lastSeen)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p style="margin-top: 10px; color: #666">No recent project traffic in the last hour.</p>
      )}
    </div>
  );
}

export function DashboardPage({
  stats,
  projects,
  deployments,
  topProjects,
  siteDomain,
  platformName,
  username,
}: DashboardProps) {
  return (
    <Layout platformName={platformName} title="Dashboard" username={username}>
      <h1>Dashboard</h1>
      <HealthStatusBanner />
      <div style="display: flex; gap: 12px">
        <a
          href="/admin/users"
          style="flex: 1; text-align: center; padding: 16px; border: 1px solid #ccc; text-decoration: none; color: inherit"
        >
          <div style="font-size: 1.5rem; font-weight: 700">{stats.users}</div>
          <div>users</div>
        </a>
        <a
          href="/admin/projects"
          style="flex: 1; text-align: center; padding: 16px; border: 1px solid #ccc; text-decoration: none; color: inherit"
        >
          <div style="font-size: 1.5rem; font-weight: 700">{stats.projects}</div>
          <div>projects</div>
        </a>
        <a
          href="/admin/deployments"
          style="flex: 1; text-align: center; padding: 16px; border: 1px solid #ccc; text-decoration: none; color: inherit"
        >
          <div style="font-size: 1.5rem; font-weight: 700">{stats.deployments}</div>
          <div>deployments</div>
        </a>
      </div>
      <TopProjectsWidget projects={topProjects} siteDomain={siteDomain} />

      <h2>Latest Projects</h2>
      <ProjectsTable projects={projects} siteDomain={siteDomain} />

      <h2>Latest Deployments</h2>
      <DeploymentTable deployments={deployments} showProject />
    </Layout>
  );
}
