import { toNextJsHandler } from "better-auth/next-js";
import { getAuth } from "@/server/auth";

export async function GET(request: Request) {
  const handler = toNextJsHandler(getAuth());
  return handler.GET(request);
}

export async function POST(request: Request) {
  const handler = toNextJsHandler(getAuth());
  return handler.POST(request);
}
