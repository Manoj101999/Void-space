import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const isWindows = process.platform === 'win32';
const envFile = join(root, '.env');
const contractState = join(root, 'packages', 'contracts', '.contracts-state.json');

function info(message) { console.log(`[dev:up] ${message}`); }
function fail(message) { console.error(`[dev:up] ${message}`); process.exit(1); }

function run(command, args, options = {}) {
  const executable = isWindows && command === 'pnpm' ? 'pnpm.cmd' : command;
  const result = spawnSync(executable, args, {
    cwd: root,
    stdio: options.capture ? ['inherit', 'pipe', 'inherit'] : 'inherit',
    env: { ...process.env, ...options.env },
    encoding: 'utf8',
    windowsHide: false,
    shell: isWindows && command === 'pnpm',
  });
  if (result.error) fail(`${command} is unavailable: ${result.error.message}`);
  if (result.status !== 0) fail(`${command} ${args.join(' ')} failed with exit code ${result.status}`);
  return result.stdout?.trim() ?? '';
}

function compose(args, options) { return run('docker', ['compose', ...args], options); }
function commandExists(command) {
  const probe = isWindows ? 'where.exe' : 'sh';
  const args = isWindows ? [command] : ['-c', `command -v ${command}`];
  return spawnSync(probe, args, { stdio: 'ignore' }).status === 0;
}

function ensureCertificate() {
  const certDir = join(root, 'docker', 'certs');
  const certFile = join(certDir, 'void-space.crt');
  const keyFile = join(certDir, 'void-space.key');
  if (existsSync(certFile) && existsSync(keyFile)) return;
  mkdirSync(certDir, { recursive: true });
  info('generating development TLS certificate');
  if (commandExists('mkcert')) {
    run('mkcert', ['-cert-file', certFile, '-key-file', keyFile, 'localhost', '*.localhost', '127.0.0.1', '::1']);
  } else if (commandExists('openssl')) {
    run('openssl', ['req', '-x509', '-nodes', '-newkey', 'rsa:2048', '-days', '825', '-keyout', keyFile, '-out', certFile, '-subj', '/C=IN/ST=Local/L=Local/O=VOID SPACE Dev/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,DNS:*.localhost,IP:127.0.0.1,IP:::1']);
  } else {
    fail('TLS certificate generation requires mkcert or openssl on PATH. Install one and rerun pnpm dev:up.');
  }
}

function waitForService(service, probe, attempts = 60) {
  info(`waiting for ${service} to become ready`);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const result = spawnSync('docker', ['compose', 'exec', '-T', service, 'sh', '-c', probe], { cwd: root, stdio: 'ignore' });
    if (result.status === 0) return;
    run('node', ['-e', 'setTimeout(() => {}, 2000)']);
  }
  compose(['logs', '--tail=40', service]);
  fail(`${service} did not become ready in time`);
}

try {
  if (!existsSync(envFile)) {
    info('creating .env from .env.example');
    copyFileSync(join(root, '.env.example'), envFile);
  }
  ensureCertificate();
  info('starting infra + edge (postgres, redis, ipfs, anvil, nginx)');
  compose(['--profile', 'infra', '--profile', 'edge', 'up', '-d']);
  const env = Object.fromEntries(readFileSync(envFile, 'utf8').split(/\r?\n/).filter(line => line && !line.startsWith('#') && line.includes('=')).map(line => {
    const index = line.indexOf('=');
    return [line.slice(0, index), line.slice(index + 1)];
  }));
  waitForService('postgres', `pg_isready -U ${env.POSTGRES_USER || 'voidspace'} -d ${env.POSTGRES_DB || 'voidspace'}`);
  waitForService('redis', 'redis-cli ping');
  waitForService('anvil', 'cast block-number --rpc-url http://localhost:8545');
  info('generating Prisma client'); run('pnpm', ['--silent', 'db:generate']);
  info('applying database migrations'); run('pnpm', ['--silent', 'db:migrate']);
  info('applying Row-Level Security policies and grants'); run('pnpm', ['--silent', 'db:rls']);

  if (existsSync(contractState) && !/^CONTRACT_ADDRESS=$/m.test(readFileSync(envFile, 'utf8'))) {
    info(`contract already deployed (delete ${contractState} to redeploy)`);
  } else if (!isWindows && commandExists('forge') && commandExists('bash')) {
    info('deploying AssetLicenseRegistry.sol to Anvil (native forge)');
    run('bash', ['packages/contracts/scripts/docker-deploy.sh'], { env: { ANVIL_RPC_URL: 'http://localhost:8545', CONTRACT_STATE_PATH: contractState } });
  } else {
    info('deploying AssetLicenseRegistry.sol to Anvil (foundry container)');
    compose(['run', '--rm', 'deploy-contracts']);
    const state = compose(['run', '--rm', '--entrypoint', 'sh', 'deploy-contracts', '-c', 'cat /shared/contracts.json'], { capture: true });
    writeFileSync(contractState, `${state}\n`);
  }

  if (existsSync(contractState)) {
    const address = JSON.parse(readFileSync(contractState, 'utf8')).contractAddress || '';
    if (address) {
      const lines = readFileSync(envFile, 'utf8').split(/\r?\n/);
      const index = lines.findIndex(line => line.startsWith('CONTRACT_ADDRESS='));
      if (index >= 0) lines[index] = `CONTRACT_ADDRESS=${address}`;
      else lines.push(`CONTRACT_ADDRESS=${address}`);
      writeFileSync(envFile, lines.join('\n'));
      info(`CONTRACT_ADDRESS=${address} written to .env`);
    }
  }
  console.log('\n  local stack is up. Run `pnpm dev` for api, worker, and web.\n');
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}