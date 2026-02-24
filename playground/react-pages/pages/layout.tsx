import { Link, useShared } from "void/react";

export default function Layout({ children }: { children: React.ReactNode }) {
  const shared = useShared();
  return (
    <div>
      <nav>
        <Link href="/">Home</Link> | <Link href="/users">Users</Link> |{" "}
        <Link href="/blog">Blog</Link> | <Link href="/deferred">Deferred</Link> |{" "}
        <span>{shared.appName}</span>
      </nav>
      <hr />
      {children}
    </div>
  );
}
