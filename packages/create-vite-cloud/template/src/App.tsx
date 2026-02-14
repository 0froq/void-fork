import { useState, useEffect } from "react";

export default function App() {
  const [data, setData] = useState<any>(null);

  useEffect(() => {
    fetch("/api/hello")
      .then((r) => r.json())
      .then(setData);
  }, []);

  return (
    <div>
      <h1>Welcome to Vite Cloud</h1>
      {data ? <pre>{JSON.stringify(data, null, 2)}</pre> : <p>Loading...</p>}
    </div>
  );
}
