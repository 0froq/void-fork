interface AppProps {
  url: string;
  visitCount: number;
}

export default function App({ url, visitCount }: AppProps) {
  return (
    <main>
      <h1>Vite Cloud SSR Playground</h1>
      <p>Rendered URL: {url}</p>
      <p>KV visit count: {visitCount}</p>
      <p>This page was rendered on the worker via src/ssr.entry.ts.</p>
    </main>
  );
}
