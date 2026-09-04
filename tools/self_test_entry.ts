/** 保留自测的直接Node入口，同时让Vitest导入时只注册外层测试。 / Keeps direct Node self-test entry points while Vitest imports only register their outer tests. */
export function runSelfTest(main: () => void | Promise<void>): void {
  if (process.env.VITEST) return;
  try {
    void Promise.resolve(main()).catch(failSelfTest);
  } catch (error) {
    failSelfTest(error);
  }
}

function failSelfTest(error: unknown): void {
  console.error(error);
  process.exitCode = 1;
}
