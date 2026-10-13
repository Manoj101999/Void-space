/**
 * Guards the stylesheet against classes the markup asks for and the CSS does not define.
 *
 * Three generations of bespoke classes were removed from `globals.css` (`vs-` → `mk-` → `os-`, 719
 * rules). That is only safe if nothing still refers to them, so this reads every class token out of the
 * JSX and checks each against the *compiled* stylesheet — catching both a class deleted by accident and
 * one that was never defined in the first place.
 *
 * It needs a build to have run: `pnpm --filter @void-space/web build`, then `pnpm ui:classes`. It reads
 * the compiled output rather than the source because Tailwind is what decides whether a utility exists,
 * and only the output shows the escaped selector it was emitted as.
 *
 * Two details make the comparison exact, and both were learned by getting them wrong:
 *
 *   1. **Selectors are escape-decoded, not string-stripped.** A selector for an arbitrary value reads
 *      `.bg-\[rgba\(10\2c 10\2c 10\2c 0\.78\)\]` — CSS escapes cycles as `\2c `, and the *space* after
 *      the hex digits ends a naive identifier match. A version of this script that merely deleted
 *      backslashes therefore reported every arbitrary value in the codebase as a miss, which made the
 *      guard useless: 35 false positives is a list nobody reads, and a real omission would have hidden
 *      in it. `decodeIdent` below undoes the escapes properly.
 *
 *   2. **Class tokens are taken by splitting on whitespace.** A class never contains a space — Tailwind
 *      writes one as an underscore — so whitespace-separated words are exactly the class list. Scanning
 *      for identifier-shaped substrings instead truncated classes like
 *      `[mask-image:radial-gradient(...)]` at the leading bracket and produced another false positive.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SRC = new URL('../apps/web/src/', import.meta.url).pathname;
const CSS_DIR = new URL('../apps/web/.next/static/css/', import.meta.url).pathname;

function walk(directory, extension) {
  const out = [];
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full, extension));
    else if (full.endsWith(extension)) out.push(full);
  }
  return out;
}

let cssFiles;
try {
  cssFiles = walk(CSS_DIR, '.css');
} catch (error) {
  // Only a missing build is worth reporting as such; anything else is a bug in this script.
  if (error.code !== 'ENOENT') throw error;
  console.error(
    `No compiled stylesheet at ${CSS_DIR}\n` +
      'Run the web build first:  pnpm --filter @void-space/web build',
  );
  process.exit(1);
}

if (cssFiles.length === 0) {
  console.error(`No CSS in ${CSS_DIR}. Run the web build first:  pnpm --filter @void-space/web build`);
  process.exit(1);
}

const css = cssFiles.map((file) => readFileSync(file, 'utf8')).join('\n');

/**
 * Undo CSS identifier escaping.
 *
 * `\2c ` is a comma, `\.` is a literal dot, and a bare `\` before punctuation means that punctuation.
 * Hex escapes may be followed by a single space terminator, which is part of the escape and not part of
 * the name — dropping it is what lets `\2c 10` rejoin into `,10`.
 */
function decodeIdent(raw) {
  return raw.replace(/\\([0-9a-fA-F]{1,6})\s?|\\(.)/g, (_, hex, char) =>
    hex ? String.fromCodePoint(Number.parseInt(hex, 16)) : char,
  );
}

/**
 * Remove comments before looking for class names.
 *
 * A comment is not markup, and this is not a hypothetical: the note in `ui/field.tsx` explaining the
 * `tailwind-merge` trap writes `bg-…` inside backticks, and without this the scanner reads that sentence
 * as a class called `bg-…` and reports it. Stripping is confined to comment syntax so the `//` in a URL —
 * which does appear, in the data URI above — is left alone.
 */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:'"`\w])\/\/[^\n]*/g, '$1');
}

/**
 * Every string literal that could be a class list.
 *
 * Class names are written three ways in this codebase, and a guard that understands only the first is
 * the reason this script missed the place typos actually occur:
 *
 *   `className="rounded-control px-3"`                  a plain attribute
 *   `className={cn('px-3', active && 'bg-veil-8')}`     a merge call — 57 sites
 *   `className={cn(buttonVariants({ size }), 'mt-4')}`  a variant call plus an override
 *
 * So rather than pattern-matching attributes, this collects the argument text of every `cn(...)` and
 * `buttonVariants(...)` call in the file (balanced, so a nested call does not truncate it) plus every
 * plain `className="..."`, strips comments, and pulls the string literals out of what remains. A literal
 * anywhere inside a class-building call is a class list, whether or not it sits directly on an element.
 */
function classStrings(source) {
  const chunks = [...source.matchAll(/className="([^"]*)"/g)].map((match) => match[1]);

  for (const call of source.matchAll(/\b(?:cn|buttonVariants)\s*\(/g)) {
    let depth = 0;
    let index = call.index + call[0].length - 1;
    const start = index + 1;

    // Walk to the matching close paren, so a nested `cn(...)` or `buttonVariants({...})` is included
    // rather than ending the argument early.
    for (; index < source.length; index += 1) {
      const char = source[index];
      if (char === '(') depth += 1;
      else if (char === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
    }

    chunks.push(source.slice(start, index));
  }

  const literals = [];
  for (const chunk of chunks) {
    // Single- and double-quoted literals, and backticks. A template literal with an interpolation is
    // dropped: which branch runs is not statically knowable.
    for (const match of stripComments(chunk).matchAll(/'([^'\\]*)'|"([^"\\]*)"|`([^`]*)`/g)) {
      const value = match[1] ?? match[2] ?? match[3] ?? '';
      if (value.includes('${')) continue;
      if (value.length > 0) literals.push(value);
    }
  }

  return literals;
}

const defined = new Set();
for (const match of css.matchAll(/\.((?:\\[0-9a-fA-F]{1,6}\s?|\\.|[-\w])+)/g)) {
  defined.add(decodeIdent(match[1]));
}

/** Display words that are a class on their own, with no dash or colon to identify them. */
const BARE = new Set([
  'flex',
  'grid',
  'block',
  'hidden',
  'relative',
  'absolute',
  'sticky',
  'static',
  'truncate',
  'underline',
  'italic',
]);

/** Utility-shaped: carries a dash, a variant colon, or is an arbitrary property in brackets. */
function looksLikeUtility(name) {
  return name.includes('-') || name.includes(':') || name.startsWith('[') || BARE.has(name);
}

const missing = new Map();

for (const file of walk(SRC, '.tsx')) {
  const relative = file.slice(SRC.length);

  for (const literal of classStrings(readFileSync(file, 'utf8'))) {
    for (const name of literal.split(/\s+/)) {
      if (name.length < 2) continue;
      if (!looksLikeUtility(name)) continue;
      if (defined.has(name)) continue;
      missing.set(name, (missing.get(name) ?? []).concat(relative));
    }
  }
}


if (missing.size === 0) {
  console.log('every class used in JSX resolves to a rule in the compiled stylesheet');
} else {
  console.log(`${missing.size} class(es) used in JSX with no matching rule:\n`);
  for (const [name, files] of [...missing].sort()) {
    console.log(`  ${name}\n      ${[...new Set(files)].join(', ')}`);
  }
  console.log(
    '\nEvery entry above is a real gap: a class name that Tailwind did not emit, so the element renders\n' +
      'without it. The usual causes are a misspelled utility, a renamed theme token, and a stray space\n' +
      'inside an arbitrary value — a class name cannot contain one, so `bg-[url(...<svg ...>...)]` splits\n' +
      'into several classes and applies none of them.',
  );
  process.exitCode = 1;
}

