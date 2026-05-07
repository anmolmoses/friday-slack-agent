import path from "node:path";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { reindexIncremental } from "./engram-bridge.ts";

const REPO_ROOT = path.resolve(import.meta.dir, "../..");
const VOICE_ROOT = path.join(REPO_ROOT, "memory", "voice");
const PEOPLE_ROOT = path.join(VOICE_ROOT, "people");
const FEATURE_BINS = [
  140, 190, 260, 360, 500, 700, 980, 1380, 1940, 2720, 3820,
];

export interface VoicePersonSample {
  path: string;
  capturedAt: string;
  durationMs: number;
  sampleRate: number;
  format: string;
  feature: number[];
}

export interface VoicePersonProfile {
  id: string;
  name: string;
  relationship?: string;
  notes?: string;
  createdAt: string;
  updatedAt: string;
  samples: VoicePersonSample[];
}

export interface VoicePersonMatch {
  id: string;
  name: string;
  relationship?: string;
  notes?: string;
  samplePath: string;
  similarity: number;
  distance: number;
  confidence: number;
  durationMs: number;
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
  return slug || "unknown-speaker";
}

function yamlStr(s: string): string {
  return JSON.stringify(s);
}

function profilePath(id: string): string {
  return path.join(PEOPLE_ROOT, id, "profile.json");
}

function cardPath(id: string): string {
  return path.join(PEOPLE_ROOT, id, "profile.md");
}

function loadProfile(id: string): VoicePersonProfile | null {
  try {
    return JSON.parse(readFileSync(profilePath(id), "utf-8")) as VoicePersonProfile;
  } catch {
    return null;
  }
}

function listProfiles(): VoicePersonProfile[] {
  let ids: string[];
  try {
    ids = readdirSync(PEOPLE_ROOT);
  } catch {
    return [];
  }
  return ids
    .map((id) => loadProfile(id))
    .filter((p): p is VoicePersonProfile => Boolean(p));
}

function pcmSamples(pcm: Uint8Array): Float32Array {
  const n = Math.floor(pcm.byteLength / 2);
  const dv = new DataView(pcm.buffer, pcm.byteOffset, n * 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = dv.getInt16(i * 2, true) / 32768;
  return out;
}

function rms(samples: Float32Array, start: number, len: number): number {
  let sum = 0;
  for (let i = 0; i < len; i++) {
    const x = samples[start + i] ?? 0;
    sum += x * x;
  }
  return Math.sqrt(sum / Math.max(1, len));
}

function zcr(samples: Float32Array, start: number, len: number): number {
  let crossings = 0;
  let prev = samples[start] ?? 0;
  for (let i = 1; i < len; i++) {
    const x = samples[start + i] ?? 0;
    if ((prev >= 0 && x < 0) || (prev < 0 && x >= 0)) crossings++;
    prev = x;
  }
  return crossings / Math.max(1, len - 1);
}

function goertzelEnergy(
  samples: Float32Array,
  start: number,
  len: number,
  sampleRate: number,
  freq: number,
): number {
  const w = (2 * Math.PI * freq) / sampleRate;
  const coeff = 2 * Math.cos(w);
  let s0 = 0;
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < len; i++) {
    const x = samples[start + i] ?? 0;
    s0 = x + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return Math.max(0, s1 * s1 + s2 * s2 - coeff * s1 * s2);
}

function estimatePitch(
  samples: Float32Array,
  start: number,
  len: number,
  sampleRate: number,
): number {
  const minLag = Math.max(1, Math.floor(sampleRate / 300));
  const maxLag = Math.min(len - 1, Math.floor(sampleRate / 70));
  let energy = 0;
  for (let i = 0; i < len; i++) {
    const x = samples[start + i] ?? 0;
    energy += x * x;
  }
  if (energy <= 1e-8) return 0;

  let bestLag = 0;
  let best = 0;
  for (let lag = minLag; lag <= maxLag; lag += 4) {
    let corr = 0;
    for (let i = 0; i < len - lag; i += 2) {
      corr += (samples[start + i] ?? 0) * (samples[start + i + lag] ?? 0);
    }
    const score = corr / energy;
    if (score > best) {
      best = score;
      bestLag = lag;
    }
  }
  return best > 0.22 && bestLag > 0 ? sampleRate / bestLag : 0;
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function std(values: number[], m = mean(values)): number {
  if (values.length === 0) return 0;
  const v = values.reduce((a, b) => a + (b - m) ** 2, 0) / values.length;
  return Math.sqrt(v);
}

function l2Normalize(values: number[]): number[] {
  const norm = Math.sqrt(values.reduce((a, b) => a + b * b, 0));
  if (!Number.isFinite(norm) || norm <= 1e-8) return values.map(() => 0);
  return values.map((v) => Number((v / norm).toFixed(6)));
}

export function voiceFeatureFromPcm(args: {
  pcm: Uint8Array;
  sampleRate: number;
}): { durationMs: number; feature: number[] } {
  const samples = pcmSamples(args.pcm);
  const durationMs = Math.round((samples.length / args.sampleRate) * 1000);
  const frameLen = Math.max(240, Math.round(args.sampleRate * 0.04));
  const hop = Math.max(120, Math.round(args.sampleRate * 0.02));
  const frameRms: number[] = [];
  const frameZcr: number[] = [];
  const framePitch: number[] = [];
  const bandMeans = FEATURE_BINS.map(() => [] as number[]);

  for (let start = 0; start + frameLen <= samples.length; start += hop) {
    const r = rms(samples, start, frameLen);
    if (r < 0.012) continue;
    frameRms.push(Math.log1p(r * 30));
    frameZcr.push(zcr(samples, start, frameLen));
    framePitch.push(estimatePitch(samples, start, frameLen, args.sampleRate) / 300);

    const energies = FEATURE_BINS.map((f) =>
      goertzelEnergy(samples, start, frameLen, args.sampleRate, f),
    );
    const total = energies.reduce((a, b) => a + b, 0) || 1;
    for (let i = 0; i < energies.length; i++) {
      bandMeans[i]!.push(Math.log1p((energies[i]! / total) * 100));
    }
  }

  if (frameRms.length < 3) {
    throw new Error(
      `voice sample too short or quiet for speaker recognition (${durationMs}ms)`,
    );
  }

  const vector = [
    mean(frameRms),
    std(frameRms),
    mean(frameZcr),
    std(frameZcr),
    mean(framePitch),
    std(framePitch),
    ...bandMeans.map((v) => mean(v)),
    ...bandMeans.map((v) => std(v)),
  ];
  return { durationMs, feature: l2Normalize(vector) };
}

function similarity(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let dot = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < n; i++) {
    dot += (a[i] ?? 0) * (b[i] ?? 0);
    aa += (a[i] ?? 0) ** 2;
    bb += (b[i] ?? 0) ** 2;
  }
  if (aa <= 1e-8 || bb <= 1e-8) return 0;
  return Math.max(0, Math.min(1, dot / Math.sqrt(aa * bb)));
}

function confidenceFromSimilarity(sim: number): number {
  return Math.max(0, Math.min(1, (sim - 0.55) / 0.35));
}

function writeWavFile(file: string, pcm: Uint8Array, sampleRate: number): void {
  const dataSize = pcm.byteLength;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);
  writeFileSync(file, Buffer.concat([header, Buffer.from(pcm)]));
}

function renderVoiceCard(profile: VoicePersonProfile): string {
  const latest = profile.samples.at(-1);
  return [
    "---",
    `date: ${profile.updatedAt}`,
    "tier: semantic",
    "importance: 0.8",
    "metadata:",
    "  type: voice_identity",
    `  person_id: ${yamlStr(profile.id)}`,
    `  people: ${yamlStr(profile.name)}`,
    `  relationship: ${yamlStr(profile.relationship ?? "")}`,
    '  topic: "speaker_identity"',
    `  sample_count: ${profile.samples.length}`,
    latest ? `  latest_voice_sample: ${yamlStr(latest.path)}` : "",
    "---",
    "",
    `# Voice identity: ${profile.name}`,
    "",
    `- Person: ${profile.name}`,
    profile.relationship ? `- Relationship: ${profile.relationship}` : "",
    profile.notes ? `- Notes: ${profile.notes}` : "",
    "- Use this as a tentative speaker identity cue. If confidence is not high, ask for confirmation before claiming identity.",
    "",
    "## Reference Voice Samples",
    ...profile.samples.map((sample) =>
      [
        `- ${sample.path}`,
        `  - Captured: ${sample.capturedAt}`,
        `  - Duration: ${sample.durationMs}ms`,
        `  - Format: ${sample.format}`,
      ].join("\n"),
    ),
    "",
  ]
    .filter(Boolean)
    .join("\n");
}

export async function rememberVoicePerson(args: {
  name: string;
  pcm: Uint8Array;
  sampleRate: number;
  relationship?: string;
  notes?: string;
}): Promise<{ profile: VoicePersonProfile; sample: VoicePersonSample; indexed: boolean }> {
  const name = args.name.trim();
  if (!name) throw new Error("name is required");
  const { durationMs, feature } = voiceFeatureFromPcm({
    pcm: args.pcm,
    sampleRate: args.sampleRate,
  });
  const id = slugifyName(name);
  const dir = path.join(PEOPLE_ROOT, id);
  mkdirSync(dir, { recursive: true });
  const sampleAbs = path.join(dir, artifactName("voice", "wav"));
  writeWavFile(sampleAbs, args.pcm, args.sampleRate);
  const now = new Date().toISOString();
  const sample: VoicePersonSample = {
    path: rel(sampleAbs),
    capturedAt: now,
    durationMs,
    sampleRate: args.sampleRate,
    format: "mono signed-16 PCM WAV",
    feature,
  };
  const existing = loadProfile(id);
  const profile: VoicePersonProfile = {
    id,
    name,
    relationship: args.relationship?.trim() || existing?.relationship,
    notes: args.notes?.trim() || existing?.notes,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    samples: [...(existing?.samples ?? []), sample],
  };
  writeFileSync(profilePath(id), JSON.stringify(profile, null, 2), "utf-8");
  writeFileSync(cardPath(id), renderVoiceCard(profile), "utf-8");
  const indexed = await reindexIncremental();
  return { profile, sample, indexed };
}

export async function lookupVoicePerson(args: {
  pcm: Uint8Array;
  sampleRate: number;
  limit?: number;
}): Promise<VoicePersonMatch[]> {
  const query = voiceFeatureFromPcm({
    pcm: args.pcm,
    sampleRate: args.sampleRate,
  });
  const matches: VoicePersonMatch[] = [];
  for (const profile of listProfiles()) {
    for (const sample of profile.samples) {
      const sim = similarity(query.feature, sample.feature);
      matches.push({
        id: profile.id,
        name: profile.name,
        relationship: profile.relationship,
        notes: profile.notes,
        samplePath: sample.path,
        similarity: sim,
        distance: 1 - sim,
        confidence: confidenceFromSimilarity(sim),
        durationMs: sample.durationMs,
      });
    }
  }
  return matches
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, Math.max(1, Math.min(args.limit ?? 5, 10)));
}
