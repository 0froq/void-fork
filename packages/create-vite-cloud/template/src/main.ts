const app = document.getElementById("app")!;

const res = await fetch("/api/hello");
const data = await res.json();

app.innerHTML = `
  <h1>Welcome to Vite Cloud</h1>
  <pre>${JSON.stringify(data, null, 2)}</pre>
`;
