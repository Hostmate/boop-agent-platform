import { timingSafeEqual } from "node:crypto";

export function isInteractionCanaryAuthorized(header: string | undefined, expectedToken: Buffer): boolean {
  const supplied = header?.startsWith("Bearer ") ? Buffer.from(header.slice(7)) : Buffer.alloc(0);
  return supplied.length === expectedToken.length && timingSafeEqual(supplied, expectedToken);
}
