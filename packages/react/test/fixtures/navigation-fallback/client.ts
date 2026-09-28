import React from 'react';
import type { VoidRouter } from 'void/pages-client';
import { startReactPages } from '../../../src/runtime/pages-client.ts';

let router: VoidRouter;

function Home() {
  return React.createElement(
    'main',
    null,
    React.createElement('h1', null, 'Home'),
    React.createElement(
      'button',
      { onClick: () => void router.visit('/dashboard').catch(() => {}) },
      'Dashboard',
    ),
  );
}

function Dashboard() {
  return React.createElement('h1', null, 'Dashboard loaded');
}

function NavigationFallback() {
  return React.createElement('main', null, React.createElement('h1', null, 'Loading dashboard'));
}

void startReactPages({
  components: {
    home: async () => ({ default: Home }),
    dashboard: async () => ({ default: Dashboard }),
  },
  layoutTree: {},
  routeMeta: {},
  matchRoute: (url) =>
    new URL(url, location.origin).pathname === '/dashboard' ? 'dashboard' : 'home',
  staticPageData: false,
  staticPageDataFastPath: false,
  viewTransitions: false,
  prefetchHoverDelay: 75,
  prefetchDefaultCacheFor: { stale: 0, expires: 0 },
  navigationFallback: NavigationFallback,
}).then((client) => {
  router = client.router;
});
