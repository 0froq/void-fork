import { startReactPages } from '@void/react/pages-client';
import { AdminNavigationFallback } from './AdminNavigationFallback.tsx';
import { adminComponents, adminLayoutTree, matchAdminRoute } from './pages.ts';
import './styles.css';

void startReactPages({
  components: adminComponents,
  layoutTree: adminLayoutTree,
  routeMeta: {},
  matchRoute: matchAdminRoute,
  staticPageData: false,
  staticPageDataFastPath: false,
  viewTransitions: false,
  prefetchHoverDelay: 75,
  prefetchDefaultCacheFor: { stale: 0, expires: 5 * 60_000 },
  cacheVisitedPageData: true,
  navigationFallback: AdminNavigationFallback,
});
