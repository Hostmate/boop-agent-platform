import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { z } from 'zod';

const claimsSchema = z.object({
  sub: z.string().min(1),
  tenant_id: z.string().min(1),
  user_id: z.string().min(1),
  role: z.enum(['agent', 'admin', 'superadmin']),
  permissions: z.array(z.string()),
  permissions_version: z.string().min(1),
  session_id: z.string().min(1),
  locale: z.string().min(2),
  timezone: z.string().min(1),
  effective_tenant_override: z.boolean(),
}).passthrough();

export type VerifiedActorClaims = z.infer<typeof claimsSchema> & JWTPayload;

export function createActorTokenVerifier(config: { issuer: string; audience: string; jwksUrl: string }) {
  const jwks = createRemoteJWKSet(new URL(config.jwksUrl), { cooldownDuration: 5 * 60_000, timeoutDuration: 5_000 });
  return async (token: string): Promise<VerifiedActorClaims> => {
    const verified = await jwtVerify(token, jwks, {
      algorithms: ['RS256'],
      issuer: config.issuer,
      audience: config.audience,
    });
    return claimsSchema.parse(verified.payload) as VerifiedActorClaims;
  };
}
