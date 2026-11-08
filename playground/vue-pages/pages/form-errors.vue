<script setup lang="ts">
import { action, Form, useForm } from '@void/vue';
import { ref } from 'vue';
const form = useForm('/form-errors', {
  email: '',
  name: '',
  profile: { name: '' },
  tags: [],
  photo: null,
  quantity: 3,
  published: false,
  note: null,
});
const actionSuccess = ref(false);

function uploadAction() {
  return action('/form-errors', { data: form.data }).then((result) => {
    actionSuccess.value = result.ok;
  });
}

function setErrors() {
  form.setError('email', 'Email invalid');
  form.setError('name', 'Name invalid');
  setNestedErrors();
}

function setNestedErrors() {
  form.setError('profile', 'Profile invalid');
  form.setError('tags', 'Tags invalid');
}

function editEmail(event: Event) {
  form.data.email = (event.target as HTMLInputElement).value;
  if (!form.data.email.includes('@')) {
    form.setError('email', 'Client email invalid');
  }
}
</script>

<template>
  <Form :form="form">
    <output data-testid="errors">{{ JSON.stringify(form.errors) }}</output>
    <output data-testid="success">{{ String(form.wasSuccessful) }}</output>
    <output data-testid="action-success">{{ String(actionSuccess) }}</output>
    <label>
      Photo
      <input
        type="file"
        @change="form.data.photo = ($event.target as HTMLInputElement).files?.[0] ?? null"
      />
    </label>
    <button type="button" @click="uploadAction">Upload action</button>
    <label>Email<input :value="form.data.email" @input="editEmail" /></label>
    <label>Name<input v-model="form.data.name" /></label>
    <label>Profile<input v-model="form.data.profile.name" /></label>
    <button type="button" @click="form.data.tags.push('tag')">Add tag</button>
    <button type="button" @click="setErrors">Set errors</button>
    <button type="button" @click="setNestedErrors">Set nested errors</button>
    <button type="button" @click="form.clearErrors('email')">Clear email</button>
    <button type="button" @click="form.clearErrors()">Clear all</button>
    <button type="submit" :disabled="form.pending">Save</button>
  </Form>
</template>
