/**
 * The Blender runner's filename resolution (SRS FR-6.3).
 *
 * `docker/scripts/blender-server.py` is the one surface in the product that turns a caller-supplied
 * string into a filesystem path, so it is the one place a path-traversal mistake would be a
 * file-write primitive rather than a bug. It is tested here rather than left to review because the
 * worker is the only intended caller and the two are deployed together — nothing about running the
 * stack end to end would ever exercise the rejection paths.
 *
 * The design it asserts is deliberately narrow: `input` and `output` are **filenames**, resolved
 * against the runner's own job directory. That is what stops the two containers having to agree on a
 * shared mount point. The original version took absolute paths and confined them by prefix, which
 * meant the worker's path had to be valid in the runner's namespace too — and when the compose file
 * mounted the volume at `/jobs` here and `/var/lib/void-space/blender-jobs` there, every real
 * conversion failed with a 400 while the simulation path (which never calls the runner) hid it.
 *
 * The runner is Python and stdlib-only by design, so this shells out to it rather than porting the
 * logic — a port would be a second implementation to keep in step, which is the thing being avoided.
 * Skipped when `python3` is absent, since a missing interpreter is not a defect in the runner.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const RUNNER = join(__dirname, '..', '..', '..', 'docker', 'scripts', 'blender-server.py');
const JOB_DIR = '/var/lib/void-space/blender-jobs';

const hasPython = spawnSync('python3', ['--version'], { encoding: 'utf8' }).status === 0;

interface Resolution {
  readonly accepted: boolean;
  readonly value?: string;
  readonly error?: string;
}

interface Probe {
  /** The job directory as the *runner* resolved it — see the note in `resolveAll`. */
  readonly jobDir: string;
  readonly results: readonly Resolution[];
}

/**
 * Ask the real module to resolve each case, in one interpreter.
 *
 * `BLENDER_JOB_DIR` is set for the child so the assertion does not depend on the default. The module
 * only calls `main()` under `__main__`, so importing it starts no server.
 *
 * The probe reports its own resolved `jobDir` rather than the test deriving one, because the two
 * languages disagree about unresolvable paths: Python's `os.path.realpath` resolves a path that does
 * not exist (it walks as far as it can — which is why `/var` becomes `/private/var` on macOS), while
 * Node's `realpathSync` throws `ENOENT`. Letting the implementation under test state the value keeps
 * the expectation about *its* behaviour, and stops the test failing on a difference between runtimes
 * that is not a defect.
 */
function resolveAll(cases: readonly unknown[]): Probe {
  const program = `
import importlib.util, json, os, sys

spec = importlib.util.spec_from_file_location("runner", ${JSON.stringify(RUNNER)})
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)

results = []
for case in json.loads(sys.argv[1]):
    try:
        results.append({"accepted": True, "value": runner._resolve("input", case)})
    except ValueError as exc:
        results.append({"accepted": False, "error": str(exc)})

json.dump({"jobDir": os.path.realpath(runner.JOB_DIR), "results": results}, sys.stdout)
`;

  const result = spawnSync('python3', ['-c', program, JSON.stringify(cases)], {
    encoding: 'utf8',
    env: { ...process.env, BLENDER_JOB_DIR: JOB_DIR },
  });

  if (result.status !== 0) {
    throw new Error(`runner probe failed: ${result.stderr || result.stdout}`);
  }
  return JSON.parse(result.stdout) as Probe;
}

describe.skipIf(!hasPython)('FR-6.3 blender runner path handling', () => {
  it('accepts the generated filenames the worker actually sends', () => {
    const cases = ['09eeeab7-optimized.glb', '09eeeab7-source.blend', 'a.b.glb', '.hidden'];
    const { jobDir, results } = resolveAll(cases);

    for (const [index, result] of results.entries()) {
      expect(result.accepted, `${String(cases[index])} should be accepted`).toBe(true);
      expect(result.value).toBe(`${jobDir}/${String(cases[index])}`);
    }
  });

  it('refuses anything that is a path rather than a filename', () => {
    // Every one of these is a real attempt at the shape of the bug: escaping the job directory, or
    // naming an absolute path the way the previous version of the protocol did.
    const cases = [
      '../etc/passwd',
      '..',
      '.',
      '/etc/passwd',
      `${JOB_DIR}/ok.glb`,
      'sub/dir/ok.glb',
      'a b.glb',
      '',
    ];
    const { results } = resolveAll(cases);

    for (const [index, result] of results.entries()) {
      expect(result.accepted, `${String(cases[index])} must be refused`).toBe(false);
      expect(result.error, `${String(cases[index])} should name the rule it broke`).toContain(
        'must be a filename',
      );
    }
  });

  it('refuses a missing or non-string field', () => {
    const { results } = resolveAll([null, 5, true, { a: 1 }, ['a.glb']]);
    for (const result of results) expect(result.accepted).toBe(false);
  });
});
