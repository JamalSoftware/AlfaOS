import { NextResponse } from "next/server";
import { runApi } from "@/lib/api";
import { SESSION_COOKIE_NAME } from "@/lib/constants";

export async function POST(request: Request) {
  return runApi(async () => {
    const loginUrl = new URL("/login", request.url);
    const response = NextResponse.redirect(loginUrl);
    response.cookies.set({
      name: SESSION_COOKIE_NAME,
      value: "",
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 0,
    });
    return response;
  });
}
