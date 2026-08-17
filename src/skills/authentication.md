---
skill: authentication
domains: [security, authentication, authorization]
applies_to: [security, planning, production]
priority: high
---

# Authentication & Authorization Skill

## Proven Patterns

### JWT (Stateless)
- Access token: 15-minute TTL, RS256 signing (asymmetric key pair)
- Refresh token: 7–30 day TTL, stored in httpOnly + Secure + SameSite=Lax cookie
- Rotation: rotate refresh token on every use; invalidate entire family on reuse detection
- Revocation: maintain a short-lived denylist (Redis SET with TTL = access token lifetime)
- Claims: include `sub`, `iat`, `exp`, `jti` (unique token ID), `scope`, `tenant_id`

### OAuth2 / OIDC
- Always use PKCE for SPAs and native apps (never implicit flow)
- Validate: `nonce`, `state` (CSRF protection), `aud` (audience), `iss` (issuer)
- Discovery: use `/.well-known/openid-configuration` for provider metadata
- State param: cryptographically random (32+ bytes), stored in session, verified on callback

### Session-Based
- Server-side sessions with Redis for multi-replica deployments
- Cookie: httpOnly=true, Secure=true, SameSite=Lax, MaxAge=1800 (30 min idle timeout)
- Absolute timeout: 24 hours regardless of activity
- Session ID: 128-bit cryptographically random (not sequential)

### Passkeys / WebAuthn
- Highest phishing resistance; no credential stuffing possible
- Relying party ID must match origin domain exactly
- Store: `credential_id` (base64url), `public_key` (CBOR), `sign_count`, `aaguid`
- Fallback: always provide password + MFA fallback for device-loss scenarios
- UX: "Sign in with passkey" prominent; "Use a different method" escape hatch

### API Keys
- Format: `ak_live_<32-random-bytes-base64url>` (recognizable prefix)
- Storage: store SHA-256 hash only; never store plaintext
- Features: scope (read/write/admin), expiry date, last-used timestamp, revocable
- Rotation: support overlapping keys during rotation period
- Rate limiting: per key, not just per IP

### MFA
- TOTP (RFC 6238): 30-second windows, HMAC-SHA1, 6 digits
- Backup codes: 8 codes × 10 chars, stored bcrypt-hashed, single-use
- FIDO2 hardware keys: for enterprise/high-security accounts
- Recovery: out-of-band verification (email + secondary phone)

## Anti-Patterns to Avoid

- **Symmetric JWT secrets** across services → use RS256/ES256 asymmetric keys
- **localStorage for tokens** → XSS-vulnerable; use httpOnly cookies
- **No refresh token family invalidation** → enables token theft after expiry
- **Missing absolute session timeout** → sessions that live forever
- **Rate limiting auth endpoints by IP only** → defeats distributed attacks; use account lockout after N failures
- **Storing plaintext passwords** → bcrypt (cost 12), scrypt, or Argon2id

## Authorization Patterns

### RBAC (Role-Based)
```sql
CREATE TABLE roles (id UUID PRIMARY KEY, name TEXT UNIQUE, description TEXT);
CREATE TABLE role_permissions (role_id UUID REFERENCES roles, permission TEXT, PRIMARY KEY (role_id, permission));
CREATE TABLE user_roles (user_id UUID REFERENCES users, role_id UUID REFERENCES roles, tenant_id UUID REFERENCES tenants, PRIMARY KEY (user_id, role_id, tenant_id));
```

### Row-Level Security (PostgreSQL)
```sql
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_isolation ON documents FOR ALL TO app_user
  USING (tenant_id = current_setting('app.current_tenant')::uuid);
```

### Permission Check Pattern
```typescript
async function assertPermission(userId: string, tenantId: string, resource: string, action: string): Promise<void> {
  const allowed = await db.userHasPermission(userId, tenantId, resource, action);
  if (!allowed) throw new ForbiddenError(`${action}:${resource}`, userId);
}
// Call BEFORE any data access, not just in middleware
```
