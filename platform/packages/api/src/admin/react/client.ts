import { startReactPages } from '@void/react/pages-client';
import { adminComponents, matchAdminRoute } from './pages.ts';

void startReactPages({
  components: adminComponents,
  layoutTree: {},
  routeMeta: {},
  matchRoute: matchAdminRoute,
  staticPageData: false,
  staticPageDataFastPath: false,
  viewTransitions: false,
  prefetchHoverDelay: 75,
  prefetchDefaultCacheFor: { stale: 0, expires: 0 },
});
