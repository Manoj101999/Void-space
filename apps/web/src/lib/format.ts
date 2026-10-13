/** Presentation helpers. Kept together so number, byte and time formatting stay consistent. */

export function formatBytes(bytes: number | null | undefined): string {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exponent;
  return `${value.toFixed(exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

export function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return value.toLocaleString('en-US');
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  return date.toISOString().replace('T', ' ').slice(0, 19);
}

export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return '—';
  const deltaMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(deltaMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return days < 30 ? `${days}d ago` : formatDateTime(iso).slice(0, 10);
}

/** "2.4 H" style durations, matching the telemetry register of the rest of the UI. */
export function formatHours(hours: number | null | undefined): string {
  if (hours === null || hours === undefined) return '—';
  if (hours < 1) return `${Math.round(hours * 60)} MIN`;
  if (hours < 48) return `${hours.toFixed(1)} H`;
  return `${(hours / 24).toFixed(1)} D`;
}

export function shortId(id: string | null | undefined, length = 8): string {
  if (!id) return '—';
  return id.replace(/-/g, '').slice(0, length).toUpperCase();
}

/** Trims a CID for a table cell while keeping both ends recognisable. */
export function shortCid(cid: string | null | undefined): string {
  if (!cid) return '—';
  return cid.length <= 18 ? cid : `${cid.slice(0, 9)}…${cid.slice(-6)}`;
}
