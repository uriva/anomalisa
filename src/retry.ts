const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const withRetry = <T, O>(
  retries: number,
  ms: number,
  fn: (params: T) => Promise<O>,
): (params: T) => Promise<O> =>
(params) =>
  fn(params).catch((err) =>
    retries > 0
      ? delay(ms).then(() => withRetry(retries - 1, ms * 2, fn)(params))
      : Promise.reject(err)
  );
