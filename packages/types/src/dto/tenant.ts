import { z } from 'zod';
import { roleSchema } from './auth';

/** FR-1.2 / UC-07: invite a user by email with an initial role. */
export const inviteUserSchema = z.object({
  email: z.string().email().max(254).toLowerCase(),
  fullName: z.string().min(2).max(120),
  role: roleSchema,
});
export type InviteUserInput = z.infer<typeof inviteUserSchema>;

/** FR-1.3: change a user's role or remove them (subject to the §3.6 matrix). */
export const updateUserRoleSchema = z.object({ role: roleSchema });
export type UpdateUserRoleInput = z.infer<typeof updateUserRoleSchema>;

/** FR-1.4: workspace switcher re-issues a JWT scoped to the new tenant. */
export const switchTenantSchema = z.object({ tenantId: z.string().uuid() });
export type SwitchTenantInput = z.infer<typeof switchTenantSchema>;

/** FR-1.5 / FR-14.1: SuperAdmin suspension of a tenant. */
export const setTenantStatusSchema = z.object({
  status: z.enum(['active', 'suspended']),
  reason: z.string().max(500).optional(),
});
export type SetTenantStatusInput = z.infer<typeof setTenantStatusSchema>;

/** FR-14.3: tenant-level defaults applied at upload time. */
export const tenantSettingsSchema = z.object({
  defaultPolycountBudget: z.number().int().positive().max(5_000_000).nullable().optional(),
  requiredMetadataFields: z.array(z.enum(['tags', 'sourceTool', 'license'])).default([]),
  allowedCategories: z.array(z.string().min(1).max(60)).default([]),
  webhookUrl: z.string().url().max(500).nullable().optional(),
  webhookEvents: z.array(z.string().min(1).max(60)).default([]),
});
export type TenantSettingsInput = z.infer<typeof tenantSettingsSchema>;

export interface TenantSummary {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly status: 'active' | 'suspended';
  readonly createdAt: string;
  readonly userCount?: number;
  readonly assetCount?: number;
  readonly licenseCount?: number;
}

export interface TenantUserSummary {
  readonly id: string;
  readonly email: string;
  readonly fullName: string;
  readonly roles: string[];
  readonly status: 'invited' | 'active' | 'suspended';
  readonly createdAt: string;
  readonly lastLoginAt: string | null;
}
