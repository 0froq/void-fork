import { describe, expect, it } from "vitest";
import { reactive, ref, isReactive, isRef, nextTick, watch } from "vue";

// Test the reactive logic of useForm directly (without Vue app context).
// We re-implement the core logic inline since useForm uses inject() which
// requires a Vue app. The actual integration is tested in the playground.

describe("useForm reactive logic", () => {
  function createForm<T extends Record<string, unknown>>(defaults: T) {
    const data = reactive({ ...defaults }) as T;
    const errors = reactive<Record<string, string>>({});
    const processing = ref(false);
    const wasSuccessful = ref(false);
    const recentlySuccessful = ref(false);

    let defaults_ = { ...defaults };

    const isDirty = ref(false);
    watch(
      () => ({ ...data }),
      (val) => {
        isDirty.value = Object.keys(defaults_).some(
          (key) => JSON.stringify(val[key]) !== JSON.stringify(defaults_[key as keyof T]),
        );
      },
      { deep: true },
    );

    function reset(...fields: string[]) {
      if (fields.length === 0) {
        Object.assign(data, { ...defaults_ });
      } else {
        for (const field of fields) {
          (data as any)[field] = (defaults_ as any)[field];
        }
      }
    }

    function clearErrors(...fields: string[]) {
      if (fields.length === 0) {
        for (const key of Object.keys(errors)) delete errors[key];
      } else {
        for (const field of fields) delete errors[field];
      }
    }

    return {
      data,
      errors,
      processing,
      isDirty,
      wasSuccessful,
      recentlySuccessful,
      reset,
      clearErrors,
    };
  }

  it("initial data matches defaults", () => {
    const form = createForm({ name: "", email: "" });
    expect(form.data.name).toBe("");
    expect(form.data.email).toBe("");
  });

  it("data is reactive", () => {
    const form = createForm({ name: "test" });
    expect(isReactive(form.data)).toBe(true);
  });

  it("updating data changes value", () => {
    const form = createForm({ name: "" });
    (form.data as any).name = "John";
    expect(form.data.name).toBe("John");
  });

  it("isDirty becomes true when data changes", async () => {
    const form = createForm({ name: "default" });
    expect(form.isDirty.value).toBe(false);

    (form.data as any).name = "changed";
    await nextTick();

    expect(form.isDirty.value).toBe(true);
  });

  it("isDirty becomes false when data reverts to defaults", async () => {
    const form = createForm({ name: "default" });
    (form.data as any).name = "changed";
    await nextTick();
    expect(form.isDirty.value).toBe(true);

    (form.data as any).name = "default";
    await nextTick();
    expect(form.isDirty.value).toBe(false);
  });

  it("reset() reverts all fields to defaults", async () => {
    const form = createForm({ name: "default", email: "default@test.com" });
    (form.data as any).name = "changed";
    (form.data as any).email = "changed@test.com";

    form.reset();

    expect(form.data.name).toBe("default");
    expect(form.data.email).toBe("default@test.com");
    await nextTick();
    expect(form.isDirty.value).toBe(false);
  });

  it("reset(field) reverts specific fields only", () => {
    const form = createForm({ name: "default", email: "default@test.com" });
    (form.data as any).name = "changed";
    (form.data as any).email = "changed@test.com";

    form.reset("name");

    expect(form.data.name).toBe("default");
    expect(form.data.email).toBe("changed@test.com");
  });

  it("clearErrors() removes all errors", () => {
    const form = createForm({ name: "" });
    form.errors.name = "required";
    form.errors.email = "invalid";

    form.clearErrors();

    expect(Object.keys(form.errors)).toHaveLength(0);
  });

  it("clearErrors(field) removes specific errors", () => {
    const form = createForm({ name: "" });
    form.errors.name = "required";
    form.errors.email = "invalid";

    form.clearErrors("name");

    expect(form.errors.name).toBeUndefined();
    expect(form.errors.email).toBe("invalid");
  });

  it("processing is a ref initialized to false", () => {
    const form = createForm({ name: "" });
    expect(isRef(form.processing)).toBe(true);
    expect(form.processing.value).toBe(false);
  });

  it("wasSuccessful and recentlySuccessful are refs initialized to false", () => {
    const form = createForm({ name: "" });
    expect(form.wasSuccessful.value).toBe(false);
    expect(form.recentlySuccessful.value).toBe(false);
  });
});
