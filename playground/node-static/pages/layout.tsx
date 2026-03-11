import { Link } from "@void/react";

export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <div>
      <nav>
        <Link href="/">Home</Link> | <Link href="/about">About</Link>
      </nav>
      <hr />
      {children}
    </div>
  );
}
