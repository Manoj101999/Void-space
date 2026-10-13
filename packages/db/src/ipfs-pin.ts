/**
 * Pins fixture content into IPFS (SRS FR-8.1).
 *
 * The seed used to write deterministic *placeholder* CIDs, which only resolved because content
 * had been pinned by hand during development — a fresh clone produced CIDs pointing at nothing.
 * Seeding now pins the bytes it generates, so the demo gateway links work out of the box.
 *
 * If IPFS is unreachable the seed still completes: placeholder CIDs are stored and the caller is
 * told, because a developer reseeding without the infra profile up should not be blocked.
 */
import type { Buffer } from 'node:buffer';

const ADD_TIMEOUT_MS = 15_000;

export interface PinResult {
  readonly cid: string;
  readonly bytes: number;
}

/** Uploads a buffer to the Kubo HTTP API and returns its CIDv1 (base32). */
export async function pinBuffer(apiUrl: string, content: Buffer): Promise<PinResult> {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(content)]), 'fixture.bin');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ADD_TIMEOUT_MS);

  try {
    const response = await fetch(`${apiUrl.replace(/\/$/, '')}/api/v0/add?cid-version=1&pin=true`, {
      method: 'POST',
      body: form,
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`IPFS add failed: ${response.status} ${response.statusText}`);
    }

    const payload = (await response.json()) as { Hash?: string };
    if (!payload.Hash) {
      throw new Error('IPFS add returned no Hash');
    }

    return { cid: payload.Hash, bytes: content.length };
  } finally {
    clearTimeout(timer);
  }
}

/** True when the Kubo API answers, used to decide whether pinning is even attempted. */
export async function ipfsReachable(apiUrl: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2_000);
  try {
    const response = await fetch(`${apiUrl.replace(/\/$/, '')}/api/v0/version`, {
      method: 'POST',
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
