import type { AuthConfig } from "convex/server";

const issuer = process.env.HOSTMATE_CONVEX_JWT_ISSUER;
const audience = process.env.HOSTMATE_CONVEX_JWT_AUDIENCE;
const jwks = process.env.HOSTMATE_CONVEX_JWKS_URL;

if (!issuer || !audience || !jwks) {
  throw new Error("HOSTMATE_CONVEX_JWT_ISSUER, HOSTMATE_CONVEX_JWT_AUDIENCE and HOSTMATE_CONVEX_JWKS_URL are required");
}

export default {
  providers: [{ type: "customJwt", issuer, applicationID: audience, jwks, algorithm: "RS256" }],
} satisfies AuthConfig;
