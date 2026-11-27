// Run from any directory. Minga supplies whitespace-delimited repository paths.
const modules = [
  "tokens", "parse", "ledger", "summary", "policy", "dedupe", "dispatch", "report",
];
const taskPaths = modules.map((name) => `src/${name}.ts`);

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const submitted = (process.env.MINGA_FILES ?? "").split(/\s+/).filter(Boolean);
if (process.env.MINGA_FILES !== undefined && submitted.length === 0) {
  fail("no files submitted");
}
for (const path of submitted) {
  if (!taskPaths.includes(path)) fail(`no task test for ${path}`);
  if (!(await Bun.file(new URL(path, import.meta.url)).exists())) {
    fail(`missing submitted file ${path}`);
  }
}

// Recheck landed modules too, particularly when both delivery tasks edit policy.ts.
const tests: string[] = [];
for (const [index, name] of modules.entries()) {
  if (submitted.length && !(await Bun.file(new URL(taskPaths[index]!, import.meta.url)).exists())) {
    continue;
  }
  const test = `tests/${name}.test.ts`;
  if (!(await Bun.file(new URL(test, import.meta.url)).exists())) fail(`missing ${test}`);
  tests.push(`./${test}`);
}

const result = Bun.spawnSync([process.execPath, "test", ...tests], {
  cwd: import.meta.dir,
  stdout: "inherit",
  stderr: "inherit",
});
process.exit(result.exitCode ?? 1);
