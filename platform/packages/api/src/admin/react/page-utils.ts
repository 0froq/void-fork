import { useEffect } from 'react';
import { formatPlatformPageTitle } from '../../platform-identity.ts';

export type AdminPageProps = Readonly<{
  path: string;
  platformName: string;
  username?: string;
}>;

export function useDetailTitle(title: string, platformName: string) {
  useEffect(() => {
    document.title = formatPlatformPageTitle(title, platformName);
  }, [title, platformName]);
}
