export { Sandbox } from '@cloudflare/sandbox';

export default {
  fetch() {
    return new Response('do-host', { status: 404 });
  },
};
