import { z } from 'zod';
import { ROLES, type Permission, type Role } from '../roles';

/** FR-2.1: email/password credentials; bcrypt cost ≥ 12 server-side (NFR-SEC.1). */
export const passwordSchema = z
  .string()
  .min(12, 'Password must be at least 12 characters')
  .max(200)
  .regex(/[a-z]/, 'Password must include a lowercase letter')
  .regex(/[A-Z]/, 'Password must include an uppercase letter')
  .regex(/[0-9]/, 'Password must include a digit');

export const emailSchema = z.string().email().max(254).toLowerCase();

export const roleSchema = z.enum(ROLES);
export const roleListSchema = z.array(roleSchema).min(1);

/** FR-1.1 / UC-01: create a tenant and become its first TenantAdmin. */
export const registerSchema = z.object({
  organizationName: z.string().min(2).max(120),
  organizationSlug: z
    .string()
    .min(2)
    .max(60)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Use lowercase letters, numbers and hyphens')
    .optional(),
  fullName: z.string().min(2).max(120),
  email: emailSchema,
  password: passwordSchema,
});
export type RegisterInput = z.infer<typeof registerSchema>;

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(200),
  /** Optional explicit tenant when the user belongs to more than one (FR-1.4). */
  tenantId: z.string().uuid().optional(),
});
export type LoginInput = z.infer<typeof loginSchema>;

/** FR-2.5: exchange a Developer API key for a short-lived bearer token. */
export const apiKeyExchangeSchema = z.object({ apiKey: z.string().min(20).max(200) });
export type ApiKeyExchangeInput = z.infer<typeof apiKeyExchangeSchema>;

/** FR-2.6 / EIP-4361: link or authenticate a wallet, never the sole login. */
export const siweNonceRequestSchema = z.object({ address: z.string().regex(/^0x[a-fA-F0-9]{40}$/) });
export const siweVerifySchema = z.object({
  message: z.string().min(20),
  signature: z.string().regex(/^0x[a-fA-F0-9]+$/),
});
export type SiweVerifyInput = z.infer<typeof siweVerifySchema>;

/** FR-2.7: refresh tokens are rotated; changing a password kills all sessions. */
export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: passwordSchema,
});
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

/** FR-2.6 invitation acceptance: the invitee sets their name and password. */
export const acceptInviteSchema = z.object({
  token: z.string().min(20),
  fullName: z.string().min(2).max(120),
  password: passwordSchema,
});
export type AcceptInviteInput = z.infer<typeof acceptInviteSchema>;

/** Successful sign-in payload returned alongside the auth cookies (FR-2.3). */
export interface AuthResponse {
  readonly user: SessionUser;
  readonly accessTokenExpiresIn: number;
}

/** Sign-in that needs the user to pick a workspace first (FR-1.4, FR-2.2). */
export interface TenantSelectionResponse {
  readonly requiresTenantSelection: true;
  readonly tenants: readonly { id: string; name: string; slug: string }[];
}

/** The authenticated principal derived from the access token (§3.7). */
export interface AuthPrincipal {
  readonly userId: string;
  readonly tenantId: string;
  /** Roles held in the *active* tenant, re-read from the database on every request. */
  readonly roles: readonly Role[];
  readonly permissions: readonly Permission[];
  /** 'jwt' for cookie sessions, 'apikey' for machine-to-machine tokens (FR-2.5). */
  readonly authMethod: 'jwt' | 'apikey';
  readonly apiKeyId?: string;
  readonly isSuperAdmin: boolean;
  /** Viewer-role tokens are restricted to idempotent reads (§3.6). */
  readonly readOnly: boolean;
  /** Convenience fields for audit labels and UI headers. */
  readonly email: string;
  readonly fullName: string;
  readonly tenantName: string;
  readonly tenantSlug: string;
}

/** Everything the browser needs to render the shell after sign-in (§6.1). */
export interface SessionUser {
  readonly id: string;
  readonly email: string;
  readonly fullName: string;
  readonly activeTenantId: string;
  readonly tenants: readonly { id: string; name: string; slug: string; roles: string[] }[];
  readonly roles: string[];
  readonly permissions: readonly string[];
}
