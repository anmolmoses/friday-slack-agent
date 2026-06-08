import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { App } from "@slack/bolt";

const IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

export interface SlackFile {
  url: string;
  name: string;
  mimetype: string;
}

/**
 * Collect downloadable image files from EVERY message in a thread, not just the
 * one that triggered Friday. The reporter often attaches a screenshot to the
 * thread's root message, then someone else @mentions Friday in a later reply
 * with no file — so `event.files` is empty and the image is lost on dispatch
 * (the dispatched Claude looks for /tmp/friday-files/<thread> and finds nothing).
 * Scanning the whole thread closes that gap. Fails soft to [].
 */
export async function collectThreadImageFiles(
  app: App,
  channel: string,
  threadTs: string,
): Promise<SlackFile[]> {
  try {
    const result = await app.client.conversations.replies({
      channel,
      ts: threadTs,
      inclusive: true,
      limit: 100,
    });
    const out: SlackFile[] = [];
    for (const m of result.messages ?? []) {
      const files = (m as Record<string, unknown>).files;
      if (!Array.isArray(files)) continue;
      for (const f of files as Array<Record<string, unknown>>) {
        const url = (f.url_private as string) || (f.url_private_download as string);
        const mimetype = f.mimetype as string;
        const name = f.name as string;
        if (url && name && mimetype && IMAGE_TYPES.has(mimetype)) {
          out.push({ url, name, mimetype });
        }
      }
    }
    return out;
  } catch (err) {
    console.error("[files] Failed to scan thread for image files:", err);
    return [];
  }
}

/**
 * Download image files from Slack to local disk so Claude can read them.
 * Only downloads image types; non-image files are silently skipped.
 * Returns array of local file paths for successfully downloaded files.
 */
export async function downloadSlackFiles(
  files: SlackFile[],
  threadId: string,
  botToken: string,
): Promise<string[]> {
  const imageFiles = files.filter((f) => IMAGE_TYPES.has(f.mimetype));
  if (imageFiles.length === 0) return [];

  const dir = join("/tmp", "friday-files", threadId);
  await mkdir(dir, { recursive: true });

  const paths: string[] = [];

  for (const file of imageFiles) {
    try {
      const response = await fetch(file.url, {
        headers: { Authorization: `Bearer ${botToken}` },
      });

      if (!response.ok) {
        console.error(
          `[files] Failed to download ${file.name}: ${response.status} ${response.statusText}`,
        );
        continue;
      }

      const filePath = join(dir, file.name);
      const buffer = await response.arrayBuffer();
      await Bun.write(filePath, buffer);
      paths.push(filePath);
    } catch (err) {
      console.error(`[files] Error downloading ${file.name}:`, err);
    }
  }

  return paths;
}
