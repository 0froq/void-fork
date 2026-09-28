/** @jsxImportSource @voidcloud/api/admin-jsx */
import { Banner } from '@astryxdesign/core/Banner';
import { Card } from '@astryxdesign/core/Card';
import { Skeleton } from '@astryxdesign/core/Skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from '@astryxdesign/core/Table';
import { Heading, Text } from '@astryxdesign/core/Text';
import {
  Suspense,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactElement,
  type ReactNode,
} from 'react';
import {
  useFateClient,
  useListView,
  useRequest,
  useView,
  type Deferred,
  type ViewRef,
} from 'react-fate';
import {
  DashboardView,
  dashboardRequest,
  TopProjectView,
  HealthView,
  healthRequest,
} from '../../fate/views.ts';
import { DeploymentTable } from './DeploymentTable.tsx';
import { formatAbsoluteDateTime } from './format.ts';
import { Layout } from './Layout.tsx';
import { ProjectsTable } from './ProjectsTable.tsx';
import { ProjectUrlLink } from './ProjectUrlLink.tsx';

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

const AdminSuspense = Suspense as unknown as (props: {
  children: ReactNode;
  fallback: ReactNode;
}) => ReactElement;
const subscribeToClientRender = () => () => {};
const isClientRender = () => true;
const isServerRender = () => false;

type DashboardProps = Readonly<{
  platformName: string;
  username?: string;
  healthCheckNames: ReadonlyArray<string>;
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

function HealthStatusBanner({ checkNames }: { checkNames: ReadonlyArray<string> }) {
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
  const failed = health?.checks.filter((check) => !check.ok).length ?? 0;
  const checksByName = new Map(health?.checks.map((check) => [check.name, check]));
  const summary =
    status === 'loading'
      ? ''
      : status === 'unavailable' || !health
        ? 'Unable to check system status'
        : health.allOk
          ? 'All health checks passed'
          : `${failed} health check${failed === 1 ? '' : 's'} failed`;
  return (
    <div id="health-status">
      <Banner
        status={
          status === 'unavailable'
            ? 'error'
            : status === 'loading'
              ? 'info'
              : health?.allOk
                ? 'success'
                : 'error'
        }
        title="System Status"
        description={
          <span id="health-summary" className="void-admin-health-summary">
            {summary}
          </span>
        }
        collapsible={false}
      >
        <div id="health-checks" className="void-admin-health-checks">
          {checkNames.map((name) => {
            const check = status === 'ready' ? checksByName.get(name) : undefined;
            const detail =
              status === 'loading'
                ? ''
                : !check
                  ? 'Unavailable'
                  : !check.ok
                    ? (check.error ?? 'Health check failed.')
                    : check.latencyMs > 0
                      ? `${check.latencyMs}ms`
                      : 'Healthy';
            return (
              <span key={name} className="void-admin-health-check">
                <span className="void-admin-health-indicator" aria-hidden="true">
                  {check ? (check.ok ? '✓' : '✗') : null}
                </span>
                <span>{name}</span>
                <span className="void-admin-health-detail" title={detail || undefined}>
                  {detail}
                </span>
              </span>
            );
          })}
        </div>
      </Banner>
    </div>
  );
}

function TopProjectsWidget({
  topProjects,
  siteDomain,
}: {
  topProjects: Deferred<{ items: ReadonlyArray<{ node: ViewRef<'AdminTopProject'> }> }>;
  siteDomain: string;
}) {
  const [projects] = useListView({ items: { node: TopProjectView } }, topProjects);
  return (
    <Card>
      <Heading level={2}>Top 10 Projects</Heading>
      <Text type="supporting">Last hour, site traffic only (static / ssr / isr)</Text>
      {projects.length > 0 ? (
        <Table className="void-admin-top-projects-table" hasHover>
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
            {projects.map(({ node }, index) => (
              <TopProjectTableRow
                key={node.id}
                projectRef={node}
                index={index}
                siteDomain={siteDomain}
              />
            ))}
          </TableBody>
        </Table>
      ) : (
        <Text type="supporting">No recent project traffic in the last hour.</Text>
      )}
    </Card>
  );
}

function TopProjectTableRow({
  projectRef,
  index,
  siteDomain,
}: {
  projectRef: ViewRef<'AdminTopProject'>;
  index: number;
  siteDomain: string;
}) {
  const project = useView(TopProjectView, projectRef);
  return (
    <TableRow>
      <TableCell>{index + 1}</TableCell>
      <TableCell>
        <div className="void-admin-top-project">
          <div className="void-admin-top-project-heading">
            <a
              className="void-admin-top-project-name"
              href={`/admin/projects/${project.id}`}
              title={project.slug}
            >
              {project.slug}
            </a>
            <span className="void-admin-top-project-type">{project.type}</span>
          </div>
          <div className="void-admin-top-project-meta">
            <ProjectUrlLink url={project.url ?? `https://${project.slug}.${siteDomain}`} />
          </div>
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
  );
}

function DeferredTopProjects({
  topProjects,
  siteDomain,
}: {
  topProjects: Deferred<{ items: ReadonlyArray<{ node: ViewRef<'AdminTopProject'> }> }>;
  siteDomain: string;
}) {
  const mounted = useSyncExternalStore(subscribeToClientRender, isClientRender, isServerRender);
  const fallback = (
    <Card>
      <Heading level={2}>Top 10 Projects</Heading>
      <Text type="supporting">Last hour, site traffic only (static / ssr / isr)</Text>
      <Skeleton width="100%" height={48} />
      <Skeleton width="100%" height={48} index={1} />
    </Card>
  );
  if (!mounted) {
    return fallback;
  }
  return (
    <AdminSuspense fallback={fallback}>
      <TopProjectsWidget topProjects={topProjects} siteDomain={siteDomain} />
    </AdminSuspense>
  );
}

export function DashboardPage({ platformName, username, healthCheckNames }: DashboardProps) {
  const { dashboard: dashboardRef } = useRequest(dashboardRequest, {
    mode: 'stale-while-revalidate',
  });
  const dashboard = useView(DashboardView, dashboardRef);
  if (!dashboard) {
    throw new Error('Dashboard data is unavailable.');
  }
  return (
    <Layout platformName={platformName} title="Dashboard" username={username}>
      <Heading level={1}>Dashboard</Heading>
      <HealthStatusBanner checkNames={healthCheckNames} />
      <div className="void-admin-metrics">
        <a href="/admin/users">
          <Card>
            <Text type="supporting" display="block">
              Users
            </Text>
            <Text type="display-3" display="block" hasTabularNumbers>
              {formatNumber(dashboard.userCount)}
            </Text>
          </Card>
        </a>
        <a href="/admin/projects">
          <Card>
            <Text type="supporting" display="block">
              Projects
            </Text>
            <Text type="display-3" display="block" hasTabularNumbers>
              {formatNumber(dashboard.projectCount)}
            </Text>
          </Card>
        </a>
        <a href="/admin/deployments">
          <Card>
            <Text type="supporting" display="block">
              Deployments
            </Text>
            <Text type="display-3" display="block" hasTabularNumbers>
              {formatNumber(dashboard.deploymentCount)}
            </Text>
          </Card>
        </a>
      </div>
      <DeferredTopProjects topProjects={dashboard.topProjects} siteDomain={dashboard.siteDomain} />

      <Heading level={2}>Latest Projects</Heading>
      <ProjectsTable projects={dashboard.projects} siteDomain={dashboard.siteDomain} />

      <Heading level={2}>Latest Deployments</Heading>
      <DeploymentTable deployments={dashboard.deployments} showProject />
    </Layout>
  );
}
