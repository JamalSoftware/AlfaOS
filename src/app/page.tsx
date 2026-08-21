import { redirect } from "next/navigation";
import { defaultPageFor } from "@/lib/guards";
import { getSessionUser } from "@/lib/session";

export default async function HomePage() {
  const session = await getSessionUser();
  if (session) {
    redirect(defaultPageFor(session.profile));
  }
  redirect("/login");
}
