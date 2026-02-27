<script setup lang="ts">
import { ref } from "vue";
import { useRouter } from "void/vue";
import { auth, AuthError } from "void/client";
import type { Props } from "./auth.server";

defineProps<Props>();

const router = useRouter();
const response = ref("");
const tab = ref<"login" | "register">("login");

const loginEmail = ref("");
const loginPassword = ref("");
const regEmail = ref("");
const regPassword = ref("");
const regName = ref("");

function showResponse(label: string, data: unknown) {
  response.value = `${label}:\n${JSON.stringify(data, null, 2)}`;
}

async function handleRegister() {
  try {
    const u = await auth.register({
      email: regEmail.value,
      password: regPassword.value,
      name: regName.value || undefined,
    });
    showResponse("POST /auth/register (200)", u);
    regEmail.value = "";
    regPassword.value = "";
    regName.value = "";
    router.reload();
  } catch (err) {
    if (err instanceof AuthError) {
      showResponse(`POST /auth/register (${err.status})`, err.data);
    }
  }
}

async function handleLogin() {
  try {
    const u = await auth.login({
      email: loginEmail.value,
      password: loginPassword.value,
    });
    showResponse("POST /auth/login (200)", u);
    loginEmail.value = "";
    loginPassword.value = "";
    router.reload();
  } catch (err) {
    if (err instanceof AuthError) {
      showResponse(`POST /auth/login (${err.status})`, err.data);
    }
  }
}

async function handleLogout() {
  await auth.logout();
  response.value = "Logged out";
  router.reload();
}

async function handleProfile() {
  const res = await fetch("/api/profile");
  const data = await res.json();
  showResponse(`GET /api/profile (${res.status})`, data);
}
</script>
<template>
  <div>
    <h1>Auth</h1>
    <p>Authentication via <code>void/auth</code> + <code>void/client</code>.</p>

    <div
      style="display: flex; align-items: center; border-bottom: 1px solid #ccc; margin-bottom: 15px"
    >
      <button
        @click="tab = 'login'"
        :style="{
          padding: '8px 16px',
          border: 'none',
          borderBottom: tab === 'login' ? '2px solid #333' : '2px solid transparent',
          background: 'none',
          fontWeight: tab === 'login' ? 'bold' : 'normal',
          cursor: 'pointer',
          fontFamily: 'monospace',
        }"
      >
        Login
      </button>
      <button
        @click="tab = 'register'"
        :style="{
          padding: '8px 16px',
          border: 'none',
          borderBottom: tab === 'register' ? '2px solid #333' : '2px solid transparent',
          background: 'none',
          fontWeight: tab === 'register' ? 'bold' : 'normal',
          cursor: 'pointer',
          fontFamily: 'monospace',
        }"
      >
        Register
      </button>
      <span style="margin-left: auto; padding: 8px 0; font-size: 0.9em">
        <template v-if="user">
          <strong>{{ user.name || user.email || user.id }}</strong> ({{ user.provider }}) &mdash;
          <button @click="handleLogout">Logout</button>
        </template>
        <template v-else>Not logged in</template>
      </span>
    </div>

    <section v-if="tab === 'login'">
      <h2>Email Login</h2>
      <form @submit.prevent="handleLogin">
        <div>
          <input v-model="loginEmail" type="email" placeholder="Email" required />
        </div>
        <div style="margin-top: 5px">
          <input v-model="loginPassword" type="password" placeholder="Password" required />
        </div>
        <button type="submit" style="margin-top: 5px">Login</button>
      </form>

      <h2>OAuth</h2>
      <a href="/auth/login/github"><button type="button">Login with GitHub</button></a>
      {{ " " }}
      <a href="/auth/login/google"><button type="button">Login with Google</button></a>
    </section>

    <section v-if="tab === 'register'">
      <h2>Email Register</h2>
      <form @submit.prevent="handleRegister">
        <div>
          <input v-model="regEmail" type="email" placeholder="Email" required />
        </div>
        <div style="margin-top: 5px">
          <input v-model="regPassword" type="password" placeholder="Password" required />
        </div>
        <div style="margin-top: 5px">
          <input v-model="regName" type="text" placeholder="Name (optional)" />
        </div>
        <button type="submit" style="margin-top: 5px">Register</button>
      </form>
    </section>

    <hr />

    <section>
      <h2>Protected Route</h2>
      <button @click="handleProfile">GET /api/profile</button>
      <p>Tests <code>requireAuth()</code> — returns 401 if not logged in.</p>
    </section>

    <section v-if="response">
      <h2>Response</h2>
      <pre style="background: #f5f5f5; padding: 10px; overflow: auto; white-space: pre-wrap">{{
        response
      }}</pre>
    </section>
  </div>
</template>
