import path from "node:path";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { reindexIncremental } from "./engram-bridge.ts";

const REPO_ROOT = path.resolve(import.meta.dir, "../..");
const VISION_ROOT = path.join(REPO_ROOT, "memory", "vision");
const CAMERA_ROOT = path.join(VISION_ROOT, "camera");
const PEOPLE_ROOT = path.join(VISION_ROOT, "people");
const TMP_CAMERA_ROOT = "/tmp/friday-voice/vision";
let cameraCaptureChain = Promise.resolve();

export interface CameraFrame {
  file: string;
  relPath: string;
  dims: string;
}

export interface VisualPersonImage {
  path: string;
  capturedAt: string;
  hash: string;
  description?: string;
}

export interface VisualPersonProfile {
  id: string;
  name: string;
  relationship?: string;
  notes?: string;
  createdAt: string;
  updatedAt: string;
  images: VisualPersonImage[];
}

export interface VisualPersonMatch {
  id: string;
  name: string;
  relationship?: string;
  notes?: string;
  imagePath: string;
  distance: number;
  confidence: number;
  description?: string;
}

function artifactName(prefix: string, ext: string): string {
  return `${prefix}-${new Date().toISOString().replace(/[:.]/g, "-")}.${ext}`;
}

function rel(absPath: string): string {
  if (!absPath.startsWith(REPO_ROOT)) return absPath;
  return path.relative(REPO_ROOT, absPath);
}

function slugifyName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || "unknown-person";
}

function yamlStr(s: string): string {
  return JSON.stringify(s);
}

async function runText(cmd: string[], timeoutMs = 12_000): Promise<{
  code: number;
  body: string;
}> {
  const proc = Bun.spawn(cmd, {
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
    env: process.env as Record<string, string>,
  });
  const timer = setTimeout(() => {
    try {
      proc.kill();
    } catch {
      /* already exited */
    }
  }, timeoutMs);
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  return {
    code,
    body: [out.trim(), err.trim()].filter(Boolean).join("\n"),
  };
}

async function runBytes(cmd: string[], timeoutMs = 12_000): Promise<Uint8Array> {
  const proc = Bun.spawn(cmd, {
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
    env: process.env as Record<string, string>,
  });
  const timer = setTimeout(() => {
    try {
      proc.kill();
    } catch {
      /* already exited */
    }
  }, timeoutMs);
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).arrayBuffer(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  if (code !== 0) {
    throw new Error(err.trim() || `command failed with exit ${code}`);
  }
  return new Uint8Array(out);
}

export function cameraPermissionHelp(extra = ""): string {
  return [
    "Camera capture failed.",
    "Grant Camera permission to the app launching Friday voice, usually Terminal.",
    "Open System Settings > Privacy & Security > Camera, enable Terminal, then quit Terminal completely with Cmd+Q, reopen it, and restart Friday voice.",
    extra ? `ffmpeg output:\n${extra}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export async function captureCameraFrame(args: {
  deviceIndex: string;
  width: number;
  height: number;
  warmupMs: number;
  persist?: boolean;
}): Promise<CameraFrame> {
  const outputRoot = args.persist === false ? TMP_CAMERA_ROOT : CAMERA_ROOT;
  mkdirSync(outputRoot, { recursive: true });
  const file = path.join(outputRoot, artifactName("camera", "jpg"));
  await cameraCaptureChain;
  const capture = captureCameraFrameUnlocked({ ...args, file });
  cameraCaptureChain = capture.then(
    () => undefined,
    () => undefined,
  );
  return await capture;
}

async function captureCameraFrameUnlocked(args: {
  deviceIndex: string;
  width: number;
  height: number;
  warmupMs: number;
  file: string;
}): Promise<CameraFrame> {
  const input = `${args.deviceIndex}:none`;
  const warmupSeconds = Math.max(0, args.warmupMs) / 1000;
  const cmd = [
    "ffmpeg",
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "avfoundation",
    "-framerate",
    "30",
    "-pixel_format",
    "nv12",
    "-video_size",
    `${args.width}x${args.height}`,
    "-i",
    input,
  ];
  if (warmupSeconds > 0) {
    cmd.push("-ss", String(warmupSeconds));
  }
  cmd.push(
    "-frames:v",
    "1",
    "-q:v",
    "3",
    "-y",
    args.file,
  );
  const shot = await runText(cmd);
  if (
    shot.code !== 0 ||
    !existsSync(args.file) ||
    statSync(args.file).size < 1000
  ) {
    throw new Error(cameraPermissionHelp(shot.body));
  }
  const dims = await imageDimensions(args.file);
  return { file: args.file, relPath: rel(args.file), dims };
}

export async function imageDimensions(file: string): Promise<string> {
  const dims = await runText([
    "/usr/bin/sips",
    "-g",
    "pixelWidth",
    "-g",
    "pixelHeight",
    file,
  ]);
  if (dims.code !== 0 || /Warning:|Error:/i.test(dims.body)) {
    throw new Error(dims.body || "sips could not read image dimensions");
  }
  return dims.body;
}

export async function imageFingerprint(file: string): Promise<string> {
  const bytes = await runBytes([
    "ffmpeg",
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    file,
    "-vf",
    "scale=9:8,format=gray",
    "-frames:v",
    "1",
    "-f",
    "rawvideo",
    "-",
  ]);
  if (bytes.length < 72) {
    throw new Error("image fingerprint failed: not enough pixel bytes");
  }
  let bits = 0n;
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const left = bytes[row * 9 + col] ?? 0;
      const right = bytes[row * 9 + col + 1] ?? 0;
      bits = (bits << 1n) | (left > right ? 1n : 0n);
    }
  }
  return bits.toString(16).padStart(16, "0");
}

function hammingHex(a: string, b: string): number {
  let x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let n = 0;
  while (x > 0n) {
    n += Number(x & 1n);
    x >>= 1n;
  }
  return n;
}

function profilePath(id: string): string {
  return path.join(PEOPLE_ROOT, id, "profile.json");
}

function cardPath(id: string): string {
  return path.join(PEOPLE_ROOT, id, "profile.md");
}

function loadProfile(id: string): VisualPersonProfile | null {
  try {
    return JSON.parse(readFileSync(profilePath(id), "utf-8")) as VisualPersonProfile;
  } catch {
    return null;
  }
}

function listProfiles(): VisualPersonProfile[] {
  let ids: string[];
  try {
    ids = readdirSync(PEOPLE_ROOT);
  } catch {
    return [];
  }
  return ids
    .map((id) => loadProfile(id))
    .filter((p): p is VisualPersonProfile => Boolean(p));
}

function renderPersonCard(profile: VisualPersonProfile): string {
  const latest = profile.images.at(-1);
  return [
    "---",
    `date: ${profile.updatedAt}`,
    "tier: semantic",
    "importance: 0.8",
    "metadata:",
    "  type: visual_identity",
    `  person_id: ${yamlStr(profile.id)}`,
    `  people: ${yamlStr(profile.name)}`,
    `  relationship: ${yamlStr(profile.relationship ?? "")}`,
    '  topic: "person_identity"',
    `  image_count: ${profile.images.length}`,
    latest ? `  latest_image: ${yamlStr(latest.path)}` : "",
    "---",
    "",
    `# Visual identity: ${profile.name}`,
    "",
    `- Person: ${profile.name}`,
    profile.relationship ? `- Relationship: ${profile.relationship}` : "",
    profile.notes ? `- Notes: ${profile.notes}` : "",
    "- Use this as a tentative visual identity cue. If confidence is not high, ask for confirmation before claiming identity.",
    "",
    "## Reference Images",
    ...profile.images.map((img) =>
      [
        `- ${img.path}`,
        `  - Captured: ${img.capturedAt}`,
        `  - Visual hash: ${img.hash}`,
        img.description ? `  - Description: ${img.description}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    ),
    "",
  ]
    .filter(Boolean)
    .join("\n");
}

export async function rememberVisualPerson(args: {
  name: string;
  imagePath: string;
  relationship?: string;
  notes?: string;
  description?: string;
}): Promise<{ profile: VisualPersonProfile; image: VisualPersonImage; indexed: boolean }> {
  const name = args.name.trim();
  if (!name) throw new Error("name is required");
  const inputPath = path.isAbsolute(args.imagePath)
    ? args.imagePath
    : path.resolve(REPO_ROOT, args.imagePath);
  if (!existsSync(inputPath)) throw new Error(`image not found: ${args.imagePath}`);

  const id = slugifyName(name);
  const dir = path.join(PEOPLE_ROOT, id);
  mkdirSync(dir, { recursive: true });
  const ext = path.extname(inputPath).toLowerCase() || ".jpg";
  const imageAbs = path.join(dir, artifactName("person", ext.replace(/^\./, "")));
  copyFileSync(inputPath, imageAbs);
  const hash = await imageFingerprint(imageAbs);
  const now = new Date().toISOString();
  const image: VisualPersonImage = {
    path: rel(imageAbs),
    capturedAt: now,
    hash,
    ...(args.description?.trim() ? { description: args.description.trim() } : {}),
  };
  const existing = loadProfile(id);
  const profile: VisualPersonProfile = {
    id,
    name,
    relationship: args.relationship?.trim() || existing?.relationship,
    notes: args.notes?.trim() || existing?.notes,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    images: [...(existing?.images ?? []), image],
  };
  writeFileSync(profilePath(id), JSON.stringify(profile, null, 2), "utf-8");
  writeFileSync(cardPath(id), renderPersonCard(profile), "utf-8");
  const indexed = await reindexIncremental();
  return { profile, image, indexed };
}

export async function lookupVisualPerson(args: {
  imagePath: string;
  limit?: number;
}): Promise<VisualPersonMatch[]> {
  const inputPath = path.isAbsolute(args.imagePath)
    ? args.imagePath
    : path.resolve(REPO_ROOT, args.imagePath);
  if (!existsSync(inputPath)) throw new Error(`image not found: ${args.imagePath}`);
  const queryHash = await imageFingerprint(inputPath);
  const matches: VisualPersonMatch[] = [];
  for (const profile of listProfiles()) {
    for (const image of profile.images) {
      const distance = hammingHex(queryHash, image.hash);
      matches.push({
        id: profile.id,
        name: profile.name,
        relationship: profile.relationship,
        notes: profile.notes,
        imagePath: image.path,
        distance,
        confidence: Math.max(0, 1 - distance / 64),
        description: image.description,
      });
    }
  }
  return matches
    .sort((a, b) => a.distance - b.distance)
    .slice(0, Math.max(1, Math.min(args.limit ?? 5, 10)));
}
