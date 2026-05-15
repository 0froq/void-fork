export const R2_CONCURRENCY = 6;

export async function uploadPool<T>(
  items: ReadonlyArray<T>,
  concurrency: number,
  fn: (item: T) => Promise<unknown>,
): Promise<void> {
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const item = items[i++];
      await fn(item);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
}
