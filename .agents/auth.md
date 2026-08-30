# Identity: OIDC SSO with map-by-email

Three apps, three user tables, three auth schemes today (auto-cal: jose HS256 JWT; philotes: jsonwebtoken JWT; notes: raw user-id UUID session, MVP). Unification strategy: a central OIDC provider issues one token; each app verifies it independently and **maps to its own local user row by email**, keeping its users table and native magic-link auth so standalone mode is untouched.

## Provider: build on `oidc-provider` (panva)

~300-line service in this repo's `auth/` workspace. Rationale:

- Certified OIDC implementation, pure Node — fits the all-Node stack; one small container, no admin UI to maintain; keys are a JWKS JSON in a volume.
- The *interaction* (login UI) is pluggable → reuse the org's **magic-link** pattern as the login screen (email form → nodemailer link → clicking completes the interaction).
- Off-the-shelf alternatives rejected for a single-user LAN: Zitadel (own DB + config surface), Authentik (Python, server+worker+redis), Keycloak (JVM). Ory Hydra requires building the login UI anyway. **Fallback if multi-user ever matters: Zitadel.**

### Service config

- One public client `personal-dashboard`: `authorization_code` + PKCE; redirect URIs for the LAN hostname and local dev.
- JWT access tokens (`accessTokenFormat: 'jwt'` via resourceIndicators), ES256, `audience: 'cubicecho'`, **`email` claim always present**; `sub` = auth-service user UUID.
- Storage: drizzle against the `auth` database (PGlite in dev) for users + magic links; a small drizzle adapter for oidc-provider so refresh tokens survive restarts.
- Exposes `/.well-known/openid-configuration` + `jwks_uri` — all the apps ever need.

## App-side verification: `@cubicecho/federation/auth`

```ts
export function createOidcVerifier(opts?: { issuer?: string; audience?: string }) {
  const issuer = opts?.issuer ?? process.env.OIDC_ISSUER;
  if (!issuer) return null;                      // standalone mode: feature off
  const jwks = createRemoteJWKSet(new URL('/jwks', issuer));  // jose, cached
  return async (token: string): Promise<{ email: string; sub: string } | null> => {
    try {
      const { payload } = await jwtVerify(token, jwks, {
        issuer,
        audience: opts?.audience ?? process.env.OIDC_AUDIENCE ?? 'cubicecho',
      });
      return payload.email ? { email: String(payload.email), sub: String(payload.sub) } : null;
    } catch { return null; }
  };
}
```

Each app's context builder tries, in order: **OIDC verify (when `OIDC_ISSUER` is set) → existing native scheme(s)**. On OIDC success: `findOrCreateUserByEmail(email)` (drizzle `insert … onConflictDoNothing().returning()` + select fallback), then proceed with the local `userId` exactly as today — **resolvers, CASL rules, and user scoping need zero changes**. With `OIDC_ISSUER` unset, behavior is bit-identical to today.

## Token flow (zero-trust)

1. Dashboard Expo web app runs authorization-code + PKCE (expo-auth-session or a small hand-rolled flow), stores the access token in the org's usual `storage` pattern, attaches `Authorization: Bearer <jwt>` on every request.
2. Gateway **forwards the header verbatim** (`propagateHeaders`, see [federation.md](federation.md)).
3. Every subgraph independently verifies signature/issuer/audience via JWKS.

No gateway-minted identity headers: a compromised gateway can't fabricate identity, subgraphs remain directly usable with the same token, and there's nothing to keep in sync.

## Gotchas & flags

- **Issuer URL reachability:** the issuer string baked into tokens must match what subgraphs verify *and* be resolvable from both the browser (login redirect) and containers (JWKS fetch). Use one LAN hostname (e.g. `auth.home` via router DNS or `/etc/hosts` + compose `extra_hosts`) — never `localhost`.
- **notes' raw-UUID session is the weakest link** — any bearer of a user's UUID *is* that user, and UUIDs appear in API responses. Mitigated in dashboard mode (OIDC checked first); migrate standalone notes to signed tokens as a fast-follow **in the notes repo**, not here.
- **Refresh:** v1 uses 12–24h access tokens + re-login via silent redirect (fine for a home server); add refresh-token rotation later.
- **Do not expose the issuer to the internet** without revisiting (key rotation, rate limiting, or swapping to Zitadel). LAN-only is the assumption.
