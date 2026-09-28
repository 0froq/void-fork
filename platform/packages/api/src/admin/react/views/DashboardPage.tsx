/** @jsxImportSource @voidcloud/api/admin-jsx */
import { Banner } from '@astryxdesign/core/Banner';
import { Card } from '@astryxdesign/core/Card';
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from '@astryxdesign/core/Table';
import { Heading, Text } from '@astryxdesign/core/Text';
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
    <div id="health-status">
      <Banner
        status={error ? 'error' : health === 'loading' ? 'info' : 'success'}
        title="System Status"
        description={<span id="health-summary">{summary}</span>}
        collapsible={false}
      >
        <div id="health-checks" className="void-admin-health-checks">
          {typeof health === 'object' &&
            health.checks.map((check) => (
              <span key={check.name}>
                <span aria-hidden="true">{check.ok ? '✓' : '✗'}</span> {check.name}
                {check.latencyMs > 0 ? ` (${check.latencyMs}ms)` : ''}
                {!check.ok && <span> — {check.error || 'Health check failed.'}</span>}
              </span>
            ))}
        </div>
      </Banner>
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
    <Card>
      <Heading level={2}>Top 10 Projects</Heading>
      <Text type="supporting">Last hour, site traffic only (static / ssr / isr)</Text>
      {projects.length > 0 ? (
        <Table hasHover>
          <TableHeader>
            <TableRow>
              <TableHeaderCell>#</TableHeaderCell>
              <TableHeaderCell>Project</TableHeaderCell>
              <TableHeaderCell>Owner</TableHeaderCell>
              <TableHeaderCell>Requests</TableHeaderCell>
              <TableHeaderCell>Bandwidth</TableHeaderCell>
              <TableHeaderCell>Last Seen</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {projects.map((project, index) => (
              <TableRow key={project.id}>
                <TableCell>{index + 1}</TableCell>
                <TableCell>
                  <div>
                    <a href={`/admin/projects/${project.id}`}>{project.slug}</a>
                  </div>
                  <div>
                    <a
                      className="void-admin-url"
                      href={project.url ?? `https://${project.slug}.${siteDomain}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      title={project.url ?? `${project.slug}.${siteDomain}`}
                    >
                      {project.url ?? `${project.slug}.${siteDomain}`}
                    </a>{' '}
                    · {project.type}
                  </div>
                </TableCell>
                <TableCell>
                  {project.owner_login ? (
                    <a href={`/admin/users/${project.user_id}`}>{project.owner_login}</a>
                  ) : (
                    '-'
                  )}
                </TableCell>
                <TableCell>{formatNumber(project.requests)}</TableCell>
                <TableCell>{formatBytes(project.bandwidthBytes)}</TableCell>
                <TableCell>{formatAbsoluteDateTime(project.lastSeen)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : (
        <Text type="supporting">No recent project traffic in the last hour.</Text>
      )}
    </Card>
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
      <Heading level={1}>Dashboard</Heading>
      <HealthStatusBanner />
      <div className="void-admin-metrics">
        <a href="/admin/users">
          <Card>
            <Heading level={2}>{formatNumber(stats.users)}</Heading>
            <Text>Users</Text>
          </Card>
        </a>
        <a href="/admin/projects">
          <Card>
            <Heading level={2}>{formatNumber(stats.projects)}</Heading>
            <Text>Projects</Text>
          </Card>
        </a>
        <a href="/admin/deployments">
          <Card>
            <Heading level={2}>{formatNumber(stats.deployments)}</Heading>
            <Text>Deployments</Text>
          </Card>
        </a>
      </div>
      <TopProjectsWidget projects={topProjects} siteDomain={siteDomain} />

      <Heading level={2}>Latest Projects</Heading>
      <ProjectsTable projects={projects} siteDomain={siteDomain} />

      <Heading level={2}>Latest Deployments</Heading>
      <DeploymentTable deployments={deployments} showProject />
    </Layout>
  );
}
