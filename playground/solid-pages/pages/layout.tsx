import { Link, useShared } from "@vite-cloud/solid";
import type { JSX } from "solid-js";

export default function Layout(props: { children: JSX.Element }) {
  const shared = useShared();
  return (
    <div>
      <nav>
        <Link href="/">Home</Link> | <Link href="/users">Users</Link> |{" "}
        <span>{shared.appName}</span>
      </nav>
      <hr />
      {props.children}
    </div>
  );
}
