import { Link } from "@vite-cloud/react";

interface Props {
  user: { id: number; name: string; email: string };
}

export default function UserDetailPage({ user }: Props) {
  return (
    <div>
      <h1>{user.name}</h1>
      <p>Email: {user.email}</p>
      <Link href="/users">&larr; Back to Users</Link>
    </div>
  );
}
