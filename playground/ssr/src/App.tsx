interface AppProps {
  url: string;
}

export default function App({ url }: AppProps) {
  return (
    <main>
      <h1>Vite Cloud SSR Playground</h1>
      <p>Rendered URL: {url}</p>
      <p>This page was rendered on the worker via src/ssr.entry.ts.</p>
    </main>
  );
}
