/**
 * IPFS access (SRS §3.8, FR-8.1, FR-8.2).
 *
 * Uploads use Kubo's `POST /api/v0/add` with a *streamed* multipart body: the file is
 * read from disk in chunks and piped into the request, so a 200 MB asset never has to be
 * held in memory. `pin=true` asks the local node to retain the content (FR-8.2), which
 * is what makes the CID durable rather than merely addressed.
 */
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';

export interface IpfsAddResult {
  readonly cid: string;
  readonly sizeBytes: number;
}

export interface IpfsClient {
  add(params: { readonly filePath: string; readonly fileName: string }): Promise<IpfsAddResult>;
  /** FR-8.5 — releases the pin; used when an asset is deleted. */
  unpin(cid: string): Promise<void>;
  /** True when the content is retrievable from this node (health probe, §3.10). */
  has(cid: string): Promise<boolean>;
}

interface KuboAddLine {
  readonly Name?: string;
  readonly Hash?: string;
  readonly Size?: string;
}

export function createIpfsClient(options: {
  readonly apiUrl: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}): IpfsClient {
  const base = options.apiUrl.replace(/\/$/, '');
  const timeout = options.timeoutMs ?? 120_000;
  const doFetch = options.fetchImpl ?? fetch;

  return {
    async add({ filePath, fileName }) {
      const boundary = `----voidspace${randomUUID().replace(/-/g, '')}`;
      const prologue = Buffer.from(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
          'Content-Type: application/octet-stream\r\n\r\n',
        'utf8',
      );
      const epilogue = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');

      // Stream: prologue → file chunks → epilogue. Peak memory is one chunk.
      const fileStream = Readable.toWeb(createReadStream(filePath)) as ReadableStream<Uint8Array>;
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(new Uint8Array(prologue));
          const reader = fileStream.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) controller.enqueue(value);
          }
          controller.enqueue(new Uint8Array(epilogue));
          controller.close();
        },
      });

      const response = await doFetch(
        `${base}/api/v0/add?pin=true&cid-version=1&wrap-with-directory=false`,
        {
          method: 'POST',
          headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
          body,
          // Node requires this for a streaming request body.
          duplex: 'half',
          signal: AbortSignal.timeout(timeout),
        } as RequestInit & { duplex: 'half' },
      );

      if (!response.ok) {
        throw new Error(`IPFS add failed: HTTP ${response.status} ${await response.text()}`);
      }

      // Kubo answers with newline-delimited JSON; the last line is the root entry.
      const text = await response.text();
      const lines = text
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as KuboAddLine);

      const last = lines[lines.length - 1];
      if (!last?.Hash) {
        throw new Error(`IPFS add returned no CID: ${text.slice(0, 200)}`);
      }

      return {
        cid: last.Hash,
        sizeBytes: Number.parseInt(last.Size ?? '0', 10) || 0,
      };
    },

    async unpin(cid) {
      const response = await doFetch(`${base}/api/v0/pin/rm?arg=${encodeURIComponent(cid)}`, {
        method: 'POST',
        signal: AbortSignal.timeout(30_000),
      });
      // An already-unpinned CID answers 500 with a "not pinned" message; that is a
      // no-op for us rather than an error worth failing a job over.
      if (!response.ok && response.status !== 500) {
        throw new Error(`IPFS unpin failed: HTTP ${response.status}`);
      }
    },

    async has(cid) {
      try {
        const response = await doFetch(`${base}/api/v0/block/stat?arg=${encodeURIComponent(cid)}`, {
          method: 'POST',
          signal: AbortSignal.timeout(15_000),
        });
        return response.ok;
      } catch {
        return false;
      }
    },
  };
}
