import { Link } from '@void/react';
import { Badge, HeadingSection, Spacer } from '@voidcloud/ui';
import type { Props } from './index.server.ts';

type Project = Extract<Props, { canAccessDashboard: true }>['projects'][number];

function ExternalLinkIcon() {
  return (
    <svg
      aria-hidden="true"
      className="size-4 shrink-0"
      fill="none"
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M7 17L17 7M17 7H9M17 7V15"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
      />
    </svg>
  );
}

function ChevronRightIcon() {
  return (
    <svg
      aria-hidden="true"
      className="size-4 shrink-0"
      fill="none"
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M9 18L15 12L9 6"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
      />
    </svg>
  );
}

function ProjectListItem({ project, siteDomain }: { project: Project; siteDomain: string }) {
  const domain = project.custom_domain ?? `${project.slug}.${siteDomain}`;
  const domainHref = `https://${domain}`;

  return (
    <div className="group">
      <div className="squircle border p-4 transition-[background] group-hover:bg-gray-100/40 dark:group-hover:bg-gray-900/40">
        <div className="flex cursor-pointer items-center justify-between gap-4">
          <div className="flex min-w-0 flex-wrap items-center gap-3">
            <Link
              className="underline decoration-1 underline-offset-2 hover:no-underline"
              href={`/projects/${project.id}`}
            >
              <code className="squircle bg-gray-100 p-1 dark:bg-gray-800">{project.slug}</code>
            </Link>
            <Badge
              className="border-stroke bg-white text-grey uppercase dark:border-nickel dark:bg-primary dark:text-white"
              variant="outline"
            >
              {project.type}
            </Badge>
            <a
              className="flex min-w-0 items-center gap-1 text-sm text-grey underline decoration-1 underline-offset-2 hover:text-primary hover:no-underline dark:hover:text-white"
              href={domainHref}
              rel="noopener noreferrer"
              target="_blank"
            >
              <span className="truncate">{domain}</span>
              <ExternalLinkIcon />
            </a>
          </div>
          <Link
            aria-label={`Open ${project.slug}`}
            className="text-primary transition-opacity hover:opacity-60 dark:text-white"
            href={`/projects/${project.id}`}
          >
            <ChevronRightIcon />
          </Link>
        </div>
      </div>
    </div>
  );
}

function PreviewGate() {
  return (
    <main className="bg-white dark:bg-primary">
      <HeadingSection
        heading="Preview access"
        subheading="We are working hard on the Dashboard, please use the Void CLI for now."
      />
    </main>
  );
}

export default function DashboardPage(props: Props) {
  if (!props.canAccessDashboard) {
    return <PreviewGate />;
  }

  return (
    <main className="bg-white dark:bg-primary">
      <section className="wrapper wrapper--ticks border-t bg-white px-10 py-8 dark:bg-primary">
        <div className="flex flex-col gap-2">
          <h2 className="text-3xl text-primary dark:text-white">Projects</h2>
          <p className="max-w-md text-grey">Deployments connected to your Void account.</p>
        </div>
      </section>
      <section className="wrapper wrapper--ticks border-t bg-white dark:bg-primary">
        {props.projects.length === 0 ? (
          <div className="px-10 py-8 text-grey sm:px-15 sm:py-12">
            No projects yet. Deploy an app with the Void CLI and it will appear here.
          </div>
        ) : (
          <div className="flex flex-col gap-3 p-5">
            {props.projects.map((project) => (
              <ProjectListItem key={project.id} project={project} siteDomain={props.siteDomain} />
            ))}
          </div>
        )}
      </section>
      <Spacer />
    </main>
  );
}
