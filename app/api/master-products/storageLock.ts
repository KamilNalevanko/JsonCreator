const storageQueue = new Map<string, Promise<void>>();

export const withStorageLock = async <T>(
  key: string,
  work: () => Promise<T>
): Promise<T> => {
  const prior = storageQueue.get(key) ?? Promise.resolve();
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  storageQueue.set(key, prior.then(() => gate));
  await prior;
  try {
    return await work();
  } finally {
    release();
    if (storageQueue.get(key) === gate) {
      storageQueue.delete(key);
    }
  }
};
