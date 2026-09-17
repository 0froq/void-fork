/** Public application addressing, independent of the platform API's origin. */
export type PlatformApplication = Readonly<{
  baseDomain: string;
  dedicatedZone: boolean;
  /** Empty only for an explicitly selected workers.dev installation. */
  zoneName: string;
  /** Retained after adding a domain so existing test URLs keep working. */
  workersDev?: Readonly<{ subdomain: string; installationId: string }>;
}>;

export type PlatformApplicationProject = Readonly<{ id: string; slug: string }>;

export function platformProjectIngressName(
  project: PlatformApplicationProject,
  workersDev: NonNullable<PlatformApplication['workersDev']>,
): string {
  if (!/^proj_[a-z0-9]{1,32}$/.test(project.id) || !/^[a-z0-9][a-z0-9-]*$/.test(project.slug)) {
    throw new Error('Invalid platform project identity.');
  }
  const prefix = `void-${workersDev.installationId.slice(-12)}-`;
  const suffix = `-${project.id.slice(5)}`;
  const slug = project.slug.slice(0, 63 - prefix.length - suffix.length).replace(/-+$/, '');
  return `${prefix}${slug}${suffix}`;
}

export function platformProjectWorkersDevHostname(
  project: PlatformApplicationProject,
  workersDev: NonNullable<PlatformApplication['workersDev']>,
): string {
  return `${platformProjectIngressName(project, workersDev)}.${workersDev.subdomain}.workers.dev`;
}

export function platformProjectHostname(
  project: PlatformApplicationProject,
  application: PlatformApplication,
): string {
  if (!application.zoneName && application.workersDev) {
    return platformProjectWorkersDevHostname(project, application.workersDev);
  }
  return `${project.slug}.${application.baseDomain}`;
}

export function platformProjectHostnames(
  project: PlatformApplicationProject,
  application: PlatformApplication,
): ReadonlyArray<string> {
  return [
    ...new Set([
      platformProjectHostname(project, application),
      ...(application.workersDev
        ? [platformProjectWorkersDevHostname(project, application.workersDev)]
        : []),
    ]),
  ];
}
