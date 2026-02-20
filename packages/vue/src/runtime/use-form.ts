import { reactive, ref, inject, watch } from "vue";

export function useForm<T extends Record<string, unknown>>(defaults: T) {
  const router = inject<any>("__vc_router", null);
  const data = reactive({ ...defaults }) as T;
  const errors = reactive<Record<string, string>>({});
  const processing = ref(false);
  const wasSuccessful = ref(false);
  const recentlySuccessful = ref(false);

  let defaults_ = { ...defaults };
  let successTimeout: ReturnType<typeof setTimeout> | null = null;

  // isDirty computed via deep watch
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

  async function submit(method: string, url: string, options: any = {}) {
    processing.value = true;
    wasSuccessful.value = false;
    recentlySuccessful.value = false;
    if (successTimeout) clearTimeout(successTimeout);
    clearErrors();

    try {
      const pageData = await router.visit(url, {
        method,
        data: { ...data },
        ...options,
      });

      // Bridge validation errors from the server response into the form
      if (pageData?.errors) {
        Object.assign(errors, pageData.errors);
      }

      if (Object.keys(errors).length === 0) {
        wasSuccessful.value = true;
        recentlySuccessful.value = true;
        defaults_ = { ...data } as T;
        successTimeout = setTimeout(() => {
          recentlySuccessful.value = false;
        }, 2000);
      }
    } catch {
      // Request failed
    } finally {
      processing.value = false;
    }
  }

  return reactive({
    data,
    errors,
    processing,
    isDirty,
    wasSuccessful,
    recentlySuccessful,
    reset,
    clearErrors,
    post: (url: string, opts?: any) => submit("POST", url, opts),
    put: (url: string, opts?: any) => submit("PUT", url, opts),
    patch: (url: string, opts?: any) => submit("PATCH", url, opts),
    delete: (url: string, opts?: any) => submit("DELETE", url, opts),
  });
}
