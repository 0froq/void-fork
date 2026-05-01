import { Link } from '@void/react';
import { FeatureGrid, HeadingSection, Spacer } from '@voidcloud/ui';
import type { Props } from './[id].server.ts';

function formatNumber(value: number): string {
  return new Intl.NumberFormat('en-US').format(value);
}

function formatBytes(value: number): string {
  if (value < 1024) {
    return `${value} B`;
  }
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = value / 1024;
  let unit = units[0];
  for (const next of units.slice(1)) {
    if (size < 1024) {
      break;
    }
    size /= 1024;
    unit = next;
  }
  return `${size.toFixed(size >= 10 ? 0 : 1)} ${unit}`;
}

function formatDate(value: string | null): string {
  if (!value) {
    return '-';
  }
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value));
}

function Status({ status }: { status: string }) {
  const color =
    status === 'live'
      ? 'text-zest'
      : status === 'failed' || status === 'canceled'
        ? 'text-fire'
        : 'text-grey';
  return <span className={color}>{status}</span>;
}

export default function ProjectPage({
  project,
  deployments,
  domains,
  resources,
  usage,
  secrets,
  siteDomain,
}: Props) {
  const defaultDomain = `${project.slug}.${siteDomain}`;

  return (
    <main className="bg-white dark:bg-primary">
      <HeadingSection heading={project.slug} subheading={defaultDomain} />
      <FeatureGrid
        appearance="surface"
        features={[
          {
            details: formatNumber(usage.requests),
            iconify: 'lucide:activity',
            title: 'Requests',
          },
          {
            details: formatBytes(usage.bandwidthBytes),
            iconify: 'lucide:radio-tower',
            title: 'Bandwidth',
          },
          {
            details: formatNumber(usage.aiNeurons),
            iconify: 'lucide:bot',
            title: 'AI neurons',
          },
          {
            details: project.type,
            iconify: 'lucide:box',
            title: 'Project type',
          },
        ]}
      />

      <section className="wrapper wrapper--ticks border-t bg-white dark:bg-primary">
        <div className="flex items-center justify-between border-b border-stroke px-10 py-5 dark:border-nickel">
          <Link className="text-grey hover:text-primary dark:hover:text-white" href="/">
            Projects
          </Link>
          <span className="text-sm text-grey">{project.type}</span>
        </div>
        <div className="grid lg:grid-cols-[minmax(0,1fr)_320px] lg:divide-x lg:divide-stroke lg:dark:divide-nickel">
          <div className="divide-y divide-stroke dark:divide-nickel">
            <section>
              <h3 className="px-10 py-5 text-primary dark:text-white">Deployments</h3>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[40rem] border-collapse text-left text-sm">
                  <thead>
                    <tr>
                      <th className="border-b border-stroke px-4 py-2.5 text-xs font-normal text-grey uppercase dark:border-nickel">
                        Status
                      </th>
                      <th className="border-b border-stroke px-4 py-2.5 text-xs font-normal text-grey uppercase dark:border-nickel">
                        Source
                      </th>
                      <th className="border-b border-stroke px-4 py-2.5 text-xs font-normal text-grey uppercase dark:border-nickel">
                        Commit
                      </th>
                      <th className="border-b border-stroke px-4 py-2.5 text-xs font-normal text-grey uppercase dark:border-nickel">
                        Created
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {deployments.deployments.map((deployment) => (
                      <tr key={deployment.id}>
                        <td className="border-b border-stroke px-4 py-3.5 dark:border-nickel">
                          <Status status={deployment.status} />
                          {deployment.id === deployments.activeDeploymentId && (
                            <span className="ml-2 text-xs text-grey">active</span>
                          )}
                        </td>
                        <td className="border-b border-stroke px-4 py-3.5 text-grey dark:border-nickel">
                          {deployment.source ?? '-'}
                        </td>
                        <td className="border-b border-stroke px-4 py-3.5 text-xs text-primary dark:border-nickel dark:text-white">
                          {deployment.commit ? deployment.commit.slice(0, 7) : '-'}
                        </td>
                        <td className="border-b border-stroke px-4 py-3.5 text-grey dark:border-nickel">
                          {formatDate(deployment.created_at)}
                        </td>
                      </tr>
                    ))}
                    {deployments.deployments.length === 0 && (
                      <tr>
                        <td className="px-4 py-6 text-sm text-grey" colSpan={4}>
                          No deployments yet.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="px-10 py-8">
              <h3 className="mb-6 text-primary dark:text-white">Domains</h3>
              <div className="space-y-3">
                <div className="border border-stroke p-3 dark:border-nickel">
                  <div className="flex items-center justify-between gap-4">
                    <span className="text-sm text-primary dark:text-white">{defaultDomain}</span>
                    <span className="text-sm text-zest">active</span>
                  </div>
                </div>
                {domains.map((domain) => (
                  <div key={domain.id} className="border border-stroke p-3 dark:border-nickel">
                    <div className="flex items-center justify-between gap-4">
                      <div>
                        <p className="text-sm text-primary dark:text-white">{domain.hostname}</p>
                        <p className="text-xs text-grey">{domain.status}</p>
                      </div>
                      <form method="post">
                        <input type="hidden" name="_intent" value="remove-domain" />
                        <input type="hidden" name="domainId" value={domain.id} />
                        <button className="button button--sm" type="submit">
                          Remove
                        </button>
                      </form>
                    </div>
                  </div>
                ))}
                <form className="flex gap-2" method="post">
                  <input type="hidden" name="_intent" value="add-domain" />
                  <input
                    className="min-w-0 flex-1 border border-stroke bg-white px-3 py-2 text-sm dark:border-nickel dark:bg-primary"
                    name="hostname"
                    placeholder="www.example.com"
                  />
                  <button className="button" type="submit">
                    Add
                  </button>
                </form>
              </div>
            </section>
          </div>

          <aside className="divide-y divide-stroke dark:divide-nickel">
            <section>
              <h3 className="px-5 py-5 text-primary dark:text-white">Resources</h3>
              <div className="divide-y divide-stroke dark:divide-nickel">
                {resources.map((resource) => (
                  <div key={resource.id} className="p-3">
                    <p className="text-xs text-primary dark:text-white">{resource.binding_name}</p>
                    <p className="text-xs text-grey">{resource.type}</p>
                  </div>
                ))}
                {resources.length === 0 && (
                  <div className="p-3 text-sm text-grey">No provisioned resources.</div>
                )}
              </div>
            </section>

            <section className="space-y-3 p-5">
              <h3 className="text-primary dark:text-white">Secrets</h3>
              <div className="divide-y divide-stroke border border-stroke dark:divide-nickel dark:border-nickel">
                {secrets.map((secret) => (
                  <div key={secret.name} className="flex items-center justify-between gap-3 p-3">
                    <span className="text-xs text-primary dark:text-white">{secret.name}</span>
                    <form method="post">
                      <input type="hidden" name="_intent" value="remove-secret" />
                      <input type="hidden" name="name" value={secret.name} />
                      <button className="button button--sm" type="submit">
                        Remove
                      </button>
                    </form>
                  </div>
                ))}
                {secrets.length === 0 && (
                  <div className="p-3 text-sm text-grey">No project secrets.</div>
                )}
              </div>
              <form className="space-y-2" method="post">
                <input type="hidden" name="_intent" value="add-secret" />
                <input
                  className="w-full border border-stroke bg-white px-3 py-2 text-sm dark:border-nickel dark:bg-primary"
                  name="name"
                  placeholder="API_KEY"
                />
                <input
                  className="w-full border border-stroke bg-white px-3 py-2 text-sm dark:border-nickel dark:bg-primary"
                  name="value"
                  placeholder="Secret value"
                  type="password"
                />
                <button className="button w-full" type="submit">
                  Save secret
                </button>
              </form>
            </section>
          </aside>
        </div>
      </section>
      <Spacer />
    </main>
  );
}
