import { useState, useEffect } from "react";

export default function App() {
  const [hello, setHello] = useState<string>("");
  const [users, setUsers] = useState<any[]>([]);

  useEffect(() => {
    fetch("/api/hello")
      .then((r) => r.json())
      .then(setHello);

    fetch("/api/users")
      .then((r) => r.json())
      .then(setUsers);
  }, []);

  return (
    <div>
      <h1>Vite Cloud Playground</h1>
      <h2>Hello API</h2>
      <pre>{JSON.stringify(hello, null, 2)}</pre>
      <h2>Users</h2>
      <pre>{JSON.stringify(users, null, 2)}</pre>
    </div>
  );
}
