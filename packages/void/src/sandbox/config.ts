import { fileURLToPath } from 'node:url';
import { isSandboxRegistryImage } from '@void/deploy-core';
import { isAbsolute, join } from 'pathslash';
import type { VoidConfig } from '../config.ts';

export const DEFAULT_SANDBOX_BINDING = 'SANDBOX';
export const DEFAULT_SANDBOX_CLASS_NAME = 'SandboxV1';
export const DEFAULT_SANDBOX_CONTAINER_NAME = 'void-sandbox-v1';
export const SANDBOX_MIGRATION_TAG = 'void-sandbox-v2';

export type SandboxInstanceType =
  | 'lite'
  | 'standard-1'
  | 'standard-2'
  | 'standard-3'
  | 'standard-4';

export type SandboxConfig = {
  binding?: string;
  className?: string;
  containerName?: string;
  image?: string;
  imageBuildContext?: string;
  platformImage?: string;
  instanceType?: SandboxInstanceType;
};

export type ResolvedSandboxConfig = {
  binding: string;
  className: string;
  containerName: string;
  image: string;
  imageBuildContext?: string;
  platformImage: string;
  instanceType?: SandboxInstanceType;
};

export function isSandboxEnabled(config: VoidConfig): boolean {
  return config.sandbox !== undefined && config.sandbox !== false;
}

export function getDefaultSandboxImage(): string {
  return fileURLToPath(new URL('../../sandbox.Dockerfile', import.meta.resolve('void/sandbox')));
}

export function getDefaultSandboxPlatformImage(): string {
  return 'cloudflare/debian-trixie';
}

export function isLocalSandboxImage(image: string): boolean {
  const lowerImage = image.toLowerCase();
  return (
    isAbsolute(image) ||
    image.startsWith('./') ||
    image.startsWith('../') ||
    lowerImage === 'dockerfile' ||
    lowerImage.includes('dockerfile') ||
    lowerImage.endsWith('/dockerfile') ||
    lowerImage.endsWith('\\dockerfile')
  );
}

export function requiresSandboxPlatformImage(config: VoidConfig): boolean {
  if (typeof config.sandbox !== 'object' || config.sandbox === null) {
    return false;
  }
  return (
    typeof config.sandbox.image === 'string' &&
    isLocalSandboxImage(config.sandbox.image) &&
    config.sandbox.platformImage === undefined
  );
}

export function resolveSandboxConfig(
  config: VoidConfig,
  root: string = process.cwd(),
): ResolvedSandboxConfig {
  const raw = typeof config.sandbox === 'object' ? config.sandbox : {};
  const image = raw.image ?? getDefaultSandboxImage();
  const imageBuildContext = raw.imageBuildContext;
  const platformImage =
    raw.platformImage ??
    (raw.image && !isLocalSandboxImage(raw.image) ? raw.image : getDefaultSandboxPlatformImage());

  if (!isLocalSandboxImage(image) && !isSandboxRegistryImage(image)) {
    throw new Error(
      'sandbox.image must be a Dockerfile or a digest-pinned Cloudflare registry image (registry.cloudflare.com/<account>/<image>@sha256:<digest>).',
    );
  }
  if (
    platformImage !== getDefaultSandboxPlatformImage() &&
    !isSandboxRegistryImage(platformImage)
  ) {
    throw new Error(
      'sandbox.platformImage must be a digest-pinned Cloudflare registry image (registry.cloudflare.com/<account>/<image>@sha256:<digest>).',
    );
  }

  return {
    binding: raw.binding ?? DEFAULT_SANDBOX_BINDING,
    className: raw.className ?? DEFAULT_SANDBOX_CLASS_NAME,
    containerName: raw.containerName ?? DEFAULT_SANDBOX_CONTAINER_NAME,
    image: resolveSandboxImage(image, root),
    platformImage,
    ...(imageBuildContext && {
      imageBuildContext: isAbsolute(imageBuildContext)
        ? imageBuildContext
        : join(root, imageBuildContext),
    }),
    ...(raw.instanceType && { instanceType: raw.instanceType }),
  };
}

function resolveSandboxImage(image: string, root: string): string {
  if (!isLocalSandboxImage(image) || isAbsolute(image)) {
    return image;
  }
  return join(root, image);
}

export function sandboxContainerConfig(sandbox: ResolvedSandboxConfig): Record<string, unknown> {
  return {
    name: sandbox.containerName,
    class_name: sandbox.className,
    scheduling_policy: 'durable_object',
    images: {
      default: isLocalSandboxImage(sandbox.image)
        ? {
            dockerfile: sandbox.image,
            ...(sandbox.imageBuildContext && { build_context: sandbox.imageBuildContext }),
          }
        : { image: sandbox.image },
    },
  };
}

/** Refuse namespace reuse before either uploader can change a live Worker. */
export function assertSandboxNamespaceConfig(
  config: Record<string, unknown>,
  sandbox: ResolvedSandboxConfig,
): void {
  const containers = Array.isArray(config.containers) ? config.containers : [];
  const durable = config.durable_objects as
    | { bindings?: Array<{ name: string; class_name: string }> }
    | undefined;
  if (
    containers.some(
      (container) =>
        container.class_name === sandbox.className &&
        container.scheduling_policy !== 'durable_object',
    ) ||
    durable?.bindings?.some(
      (binding) => binding.name === sandbox.binding && binding.class_name !== sandbox.className,
    )
  ) {
    throw new Error(
      'Sandbox SDK 1.0 needs a new Durable Object namespace. Back up existing Sandbox data and deploy to a fresh Worker name with the new Sandbox configuration; remove legacy Sandbox bindings, containers, and migrations from that new Worker configuration. See https://developers.cloudflare.com/containers/guides/migrate-to-durable-object-scheduling-policy/.',
    );
  }
}
