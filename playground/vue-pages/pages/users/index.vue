<script server lang="ts">
import { defineHandler } from "vite-cloud";
import { ValidationError } from "vite-cloud/handler";

const USERS = [
  { id: 1, name: "Alice", email: "alice@example.com" },
  { id: 2, name: "Bob", email: "bob@example.com" },
];

export const loader = defineHandler(() => {
  return { users: USERS };
});

export const action = defineHandler(async (c) => {
  const body = await c.req.json<{ name: string; email: string }>();
  const errors: Record<string, string> = {};

  if (!body.name?.trim()) errors.name = "Name is required";
  if (!body.email?.trim()) errors.email = "Email is required";

  if (Object.keys(errors).length > 0) {
    throw new ValidationError(errors);
  }

  USERS.push({ id: USERS.length + 1, name: body.name.trim(), email: body.email.trim() });
});
</script>

<script setup lang="ts">
import { Link, useForm } from "@vite-cloud/vue";

const props = defineProps<{
  users: Array<{ id: number; name: string; email: string }>;
}>();

const form = useForm("/users", {
  name: "",
  email: "",
});
</script>

<template>
  <div>
    <h1>Users</h1>

    <ul>
      <li v-for="user in users" :key="user.id">
        <Link :href="`/users/${user.id}`">{{ user.name }}</Link>
        ({{ user.email }})
      </li>
    </ul>

    <h2>Add User</h2>
    <form @submit.prevent="form.post()">
      <div>
        <label>Name:</label>
        <input v-model="form.data.name" />
        <span v-if="form.errors.name" style="color: red">{{ form.errors.name }}</span>
      </div>
      <div>
        <label>Email:</label>
        <input v-model="form.data.email" />
        <span v-if="form.errors.email" style="color: red">{{ form.errors.email }}</span>
      </div>
      <button type="submit" :disabled="form.processing">
        {{ form.processing ? "Saving..." : "Add User" }}
      </button>
    </form>
  </div>
</template>
