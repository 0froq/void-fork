import { Link, useShared } from "@vite-cloud/react";

export default function Layout({ children }: { children: React.ReactNode }) {
  const shared = useShared();
  return (
    <div>
      <nav>
        <Link href="/">Home</Link> | <Link href="/users">Users</Link> |{" "}
        <span>{shared.appName}</span>
      </nav>
      <hr />
      {children}
    </div>
  );
}
