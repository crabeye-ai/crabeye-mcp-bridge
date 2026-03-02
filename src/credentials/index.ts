export {
  BearerCredentialSchema,
  OAuth2CredentialSchema,
  SecretCredentialSchema,
  CredentialSchema,
  CredentialStoreFileSchema,
  resolveCredentialValue,
  type BearerCredential,
  type OAuth2Credential,
  type SecretCredential,
  type Credential,
  type CredentialStoreFile,
} from "./types.js";

export { CredentialError } from "./errors.js";

export {
  type KeychainAdapter,
  createKeychainAdapter,
  type CreateKeychainOptions,
} from "./keychain.js";

export {
  CredentialStore,
  type CredentialStoreOptions,
} from "./credential-store.js";

export {
  hasCredentialTemplates,
  resolveCredentialTemplates,
} from "./resolve-templates.js";
