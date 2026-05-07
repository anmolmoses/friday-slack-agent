import type { SessionStore } from "../../session/store/interface.ts";

export async function handleSessions(store: SessionStore): Promise<Response> {
  const allSessions = await store.getAll();
  const sessions = [...allSessions.values()]
    .sort((a, b) => b.lastActivity - a.lastActivity);

  return Response.json({ sessions });
}

export async function handleSessionDetail(
  store: SessionStore,
  threadId: string,
): Promise<Response> {
  const session = await store.get(threadId);
  if (!session) {
    return Response.json({ error: "session not found" }, { status: 404 });
  }
  return Response.json({ session });
}
