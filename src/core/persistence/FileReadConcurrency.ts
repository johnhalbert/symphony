const DEFAULT_FILE_READ_CONCURRENCY = 16;

export async function mapWithFileReadConcurrency<T, U>(
  items: readonly T[],
  mapper: (item: T, index: number) => Promise<U>,
  concurrency = DEFAULT_FILE_READ_CONCURRENCY,
): Promise<U[]> {
  if (items.length === 0) return [];

  const limit = Math.max(1, Math.min(items.length, Math.floor(concurrency)));
  const results = new Array<U>(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await mapper(items[index] as T, index);
    }
  }

  await Promise.all(Array.from({ length: limit }, () => worker()));
  return results;
}
