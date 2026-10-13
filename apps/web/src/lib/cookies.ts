/**
 * Cookie names shared with the API (FR-2.3).
 *
 * Duplicated as literals rather than imported from `apps/api`: the browser bundle must not reach
 * across the app boundary into server-only code. `packages/types` would be the tidier home, and
 * that is where these belong if a third consumer ever appears.
 */
export const ACCESS_COOKIE = 'vs_access';
export const REFRESH_COOKIE = 'vs_refresh';
