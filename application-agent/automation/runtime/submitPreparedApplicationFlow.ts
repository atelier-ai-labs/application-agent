/** Keep the awaited browser action outside the state-file lock. */
export async function authorizeThenSubmit<T>(
  withExclusiveLockAsync: <R>(operation: () => Promise<R>) => Promise<R>,
  authorize: () => void,
  submit: () => Promise<T>,
): Promise<T> {
  await withExclusiveLockAsync(async () => { authorize(); });
  return submit();
}
