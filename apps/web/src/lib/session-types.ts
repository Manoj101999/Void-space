/**
 * Session shapes shared by the client provider and the server-side gate.
 *
 * These live outside `session.tsx` on purpose: that file is a client module, and the console layout
 * is a server component. A plain types module can be imported by both without dragging a client
 * boundary across the gate.
 */
import type { Permission, Role } from '@void-space/types';

export interface SessionTenant {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
}

/** The shape of `GET /auth/me` — everything the shell needs to render itself. */
export interface SessionView {
  readonly user: {
    readonly id: string;
    readonly email: string;
    readonly fullName: string;
    readonly activeTenantId: string;
    readonly roles: readonly Role[];
    readonly permissions: readonly Permission[];
    /** Every workspace this person can switch to (FR-1.4). */
    readonly tenants?: readonly Membership[];
  };
  readonly tenant: SessionTenant;
  readonly authMethod: 'jwt' | 'apikey';
  readonly readOnly: boolean;
}

/** Multi-workspace members see a switcher (FR-1.4); the API is the source of the list. */
export interface Membership {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly roles: readonly Role[];
}
