/**
 * Structural guard: every processor's failure handling must cover its whole body.
 *
 * A processor calls `markActive()` to say "this job is running", and everything after that either
 * has to be inside the `try` whose `catch` records the outcome, or the row is left saying
 * `active` forever — with no error, no `finishedAt`, and no way for anyone to tell whether the job
 * is slow or dead. That is exactly what happened in `ai-enrichment`, where the version lookup sat
 * between `markActive()` and the `try`: any failure there escaped unrecorded, and because the
 * catch is also where a missing subject is turned into an unrecoverable failure, the job retried
 * against a deleted asset instead of stopping.
 *
 * This is a source-level check rather than a behavioural one because the requirement is
 * positional: it is about where the `try` starts, which no amount of exercising the happy path
 * would reveal. It is deliberately narrow — only comments and blank lines may sit between the two.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const PROCESSORS_DIR = join(__dirname, '..', 'src', 'processors');

/** Strips comments so only executable lines are considered. */
function codeLines(source: string): string[] {
  return source
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('//') && !line.startsWith('*'))
    .filter((line) => !line.startsWith('/*') && !line.endsWith('*/'));
}

describe('processor failure handling (FR-11.2)', () => {
  const files = readdirSync(PROCESSORS_DIR).filter((name) => name.endsWith('.ts'));

  it('finds every processor', () => {
    // A guard on the guard: if the directory moves, the assertions below would vacuously pass.
    expect(files.length).toBeGreaterThanOrEqual(5);
  });

  for (const file of files) {
    it(`${file}: starts its try immediately after markActive`, () => {
      const lines = codeLines(readFileSync(join(PROCESSORS_DIR, file), 'utf8'));
      const markIndex = lines.findIndex((line) => line.includes('ctx.markActive()'));

      expect(markIndex, `${file} never calls ctx.markActive()`).toBeGreaterThanOrEqual(0);

      const next = lines[markIndex + 1];
      expect(
        next,
        `${file}: "${next}" sits between markActive() and the try block, so a failure there would ` +
          'leave the job row stuck on "active" with no error recorded',
      ).toBe('try {');
    });
  }
});
