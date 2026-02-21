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
