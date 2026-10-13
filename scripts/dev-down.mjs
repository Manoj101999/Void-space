import { rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const volumes = args.includes('--volumes') || args.includes('-v');
const composeArgs = ['compose', '--profile', 'infra', '--profile', 'edge', '--profile', 'app', 'down', '--remove-orphans'];
if (volumes) composeArgs.splice(-1, 0, '--volumes');
const result = spawnSync('docker', composeArgs, { cwd: root, stdio: 'inherit' });
if (result.status !== 0) process.exit(result.status ?? 1);
if (volumes) rmSync(join(root, 'packages', 'contracts', '.contracts-state.json'), { force: true });