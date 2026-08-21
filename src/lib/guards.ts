import { redirect } from "next/navigation";
import type { AccessProfile } from "@prisma/client";
import { getSessionUser, type SessionUser } from "./session";

export function defaultPageFor(profile: AccessProfile): string {
  switch (profile) {
    case "TECHNICIAN":
      return "/minhas-os";
    default:
      return "/dashboard";
  }
}

export async function requirePageSession(): Promise<SessionUser> {
  const session = await getSessionUser();
  if (!session) {
    redirect("/login");
  }
  return session;
}

export async function requirePageProfile(
  profiles: AccessProfile[],
): Promise<SessionUser> {
  const session = await requirePageSession();
  if (!profiles.includes(session.profile)) {
    redirect(defaultPageFor(session.profile));
  }
  return session;
}
