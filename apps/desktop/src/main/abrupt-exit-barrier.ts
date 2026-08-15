export function exitWithoutContinuation(
  exit: (code: number) => never,
  code: number,
): never {
  return exit(code);
}
