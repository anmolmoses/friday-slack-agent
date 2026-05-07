import { describe, it, expect } from "bun:test";
import { collectThreadImageFiles } from "./files.ts";
import type { App } from "@slack/bolt";

// Build a fake Bolt App whose conversations.replies returns the given messages.
function fakeApp(messages: unknown[] | (() => never)): App {
  return {
    client: {
      conversations: {
        replies: async () => {
          if (typeof messages === "function") messages();
          return { messages };
        },
      },
    },
  } as unknown as App;
}

describe("collectThreadImageFiles", () => {
  it("collects image files across ALL thread messages (not just the trigger)", async () => {
    const app = fakeApp([
      {
        ts: "1.1",
        text: "Unable to save an uploaded image",
        files: [
          {
            name: "screenshot.png",
            mimetype: "image/png",
            url_private: "https://files.slack.com/a.png",
          },
        ],
      },
      { ts: "1.2", text: "@friday can you check this" }, // no files (the trigger)
      {
        ts: "1.3",
        files: [
          {
            name: "second.jpg",
            mimetype: "image/jpeg",
            url_private: "https://files.slack.com/b.jpg",
          },
        ],
      },
    ]);

    const out = await collectThreadImageFiles(app, "C1", "1.1");
    expect(out).toEqual([
      { url: "https://files.slack.com/a.png", name: "screenshot.png", mimetype: "image/png" },
      { url: "https://files.slack.com/b.jpg", name: "second.jpg", mimetype: "image/jpeg" },
    ]);
  });

  it("skips non-image files and entries missing url/name/mimetype", async () => {
    const app = fakeApp([
      {
        ts: "1.1",
        files: [
          { name: "doc.pdf", mimetype: "application/pdf", url_private: "https://x/doc.pdf" },
          { name: "no-url.png", mimetype: "image/png" }, // missing url
          { mimetype: "image/png", url_private: "https://x/no-name.png" }, // missing name
          { name: "ok.png", mimetype: "image/png", url_private: "https://x/ok.png" },
        ],
      },
    ]);
    const out = await collectThreadImageFiles(app, "C1", "1.1");
    expect(out).toEqual([
      { url: "https://x/ok.png", name: "ok.png", mimetype: "image/png" },
    ]);
  });

  it("returns [] when there are no messages or no files", async () => {
    expect(await collectThreadImageFiles(fakeApp([]), "C1", "1.1")).toEqual([]);
    expect(
      await collectThreadImageFiles(fakeApp([{ ts: "1.1", text: "hi" }]), "C1", "1.1"),
    ).toEqual([]);
  });

  it("fails soft to [] when the Slack API throws", async () => {
    const app = fakeApp(() => {
      throw new Error("ratelimited");
    });
    expect(await collectThreadImageFiles(app, "C1", "1.1")).toEqual([]);
  });
});
