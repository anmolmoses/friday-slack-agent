import type { ChatManager } from "../chat-manager.ts";

export async function handleChatSend(
  chatManager: ChatManager,
  body: { sessionId?: string; message: string },
): Promise<Response> {
  if (!body.message?.trim()) {
    return Response.json({ error: "message is required" }, { status: 400 });
  }

  let sessionId = body.sessionId;
  if (!sessionId || !chatManager.getSession(sessionId)) {
    const session = chatManager.createSession(sessionId ?? undefined);
    sessionId = session.id;
  }

  const session = chatManager.getSession(sessionId)!;
  if (session.status === "busy") {
    return Response.json(
      { error: "session is busy", sessionId },
      { status: 409 },
    );
  }

  // Fire and forget — response comes via SSE
  chatManager.sendMessage(sessionId, body.message.trim()).catch((err) => {
    console.error("[chat] sendMessage failed:", err);
  });

  return Response.json({ sessionId, status: "streaming" }, { status: 202 });
}

export function handleChatStream(
  chatManager: ChatManager,
  searchParams: URLSearchParams,
): Response {
  const sessionId = searchParams.get("sessionId");

  if (!sessionId) {
    return Response.json(
      { error: "sessionId query param required" },
      { status: 400 },
    );
  }

  // Create session if it doesn't exist yet (SSE opened before first POST)
  if (!chatManager.getSession(sessionId)) {
    chatManager.createSession(sessionId);
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      chatManager.setController(sessionId!, controller);
      const encoder = new TextEncoder();
      controller.enqueue(encoder.encode(": connected\n\n"));
    },
    cancel() {
      chatManager.removeController(sessionId!);
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
