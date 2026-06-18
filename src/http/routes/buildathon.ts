import type { BuildathonManager } from "../buildathon-manager.ts";

export function handleBuildathonPing(): Response {
  return Response.json({ status: "pong", ts: Date.now() });
}

export async function handleBuildathonChat(
  manager: BuildathonManager,
  body: { sessionId?: string; message: string; page?: string },
): Promise<Response> {
  if (!body.message?.trim()) {
    return Response.json({ error: "message is required" }, { status: 400 });
  }

  let sessionId = body.sessionId;
  if (!sessionId || !manager.getSession(sessionId)) {
    const session = manager.createSession(sessionId ?? undefined);
    sessionId = session.id;
  }

  const session = manager.getSession(sessionId)!;
  if (session.status === "busy") {
    return Response.json(
      { error: "hold on, I'm still thinking 💭", sessionId },
      { status: 409 },
    );
  }

  manager.sendMessage(sessionId, body.message.trim(), body.page).catch((err) => {
    console.error("[buildathon] sendMessage failed:", err);
  });

  return Response.json({ sessionId, status: "streaming" }, { status: 202 });
}

export function handleBuildathonStream(
  manager: BuildathonManager,
  searchParams: URLSearchParams,
): Response {
  const sessionId = searchParams.get("sessionId");

  if (!sessionId) {
    return Response.json(
      { error: "sessionId query param required" },
      { status: 400 },
    );
  }

  if (!manager.getSession(sessionId)) {
    manager.createSession(sessionId);
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      manager.setController(sessionId!, controller);
      const encoder = new TextEncoder();
      controller.enqueue(encoder.encode(": connected\n\n"));
    },
    cancel() {
      manager.removeController(sessionId!);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
