import { z } from "zod";

// --- Credential schemas ---

export const BearerCredentialSchema = z.object({
  type: z.literal("bearer"),
  access_token: z.string().min(1),
});

export const OAuth2CredentialSchema = z.object({
  type: z.literal("oauth2"),
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  token_endpoint: z.string().url().optional(),
  client_id: z.string().min(1).optional(),
  expires_at: z.number().int().nonnegative().finite().optional(),
});

export const CredentialSchema = z.union([
  BearerCredentialSchema,
  OAuth2CredentialSchema,
]);

export const CredentialStoreFileSchema = z.object({
  version: z.literal(1),
  credentials: z.record(z.string(), CredentialSchema),
});

// --- Inferred types ---

export type BearerCredential = z.infer<typeof BearerCredentialSchema>;
export type OAuth2Credential = z.infer<typeof OAuth2CredentialSchema>;
export type Credential = z.infer<typeof CredentialSchema>;
export type CredentialStoreFile = z.infer<typeof CredentialStoreFileSchema>;
