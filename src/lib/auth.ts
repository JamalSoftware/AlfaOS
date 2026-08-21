import { SignJWT, jwtVerify } from "jose";
import { SESSION_MAX_AGE_SECONDS, SESSION_SECRET } from "./constants";

const secret = () => new TextEncoder().encode(SESSION_SECRET);

export interface SessionClaims {
  userId: string;
}

export async function createSessionToken(userId: string): Promise<string> {
  if (!SESSION_SECRET) {
    throw new Error("AUTH_SECRET is not configured.");
  }
  return new SignJWT({ userId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_MAX_AGE_SECONDS}s`)
    .sign(secret());
}

export async function verifySessionToken(
  token: string,
): Promise<SessionClaims | null> {
  try {
    const { payload } = await jwtVerify(token, secret());
    const userId = payload.userId;
    if (typeof userId !== "string") {
      return null;
    }
    return { userId };
  } catch {
    return null;
  }
}
