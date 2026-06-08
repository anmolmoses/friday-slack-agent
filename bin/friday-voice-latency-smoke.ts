#!/usr/bin/env bun
// End-to-end smoke for the low-latency voice action path.
//
// It sends a text action request to Realtime, executes the real ToolRunner, then
// measures the daemon-style local ack/final speech path for tools and the live
// Realtime speech path for ordinary speech and image answers.

import { setTimeout as sleep } from "node:timers/promises";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { loadVoiceConfig } from "../src/voice/config.ts";
import { loadVoicePersona } from "../src/voice/persona.ts";
import { RealtimeClient } from "../src/voice/realtime.ts";
import {
  completeShortSentence,
  danglingEnding,
} from "../src/voice/speech-text.ts";
import {
  ToolRunner,
  toolDefsForConfig,
  type ToolRunResult,
} from "../src/voice/tools.ts";
import { finalToolSpeech } from "../src/voice/tool-final.ts";

const DEFAULT_COMMAND = "sleep 2; printf friday-background-e2e-ok";
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_FIRST_AUDIO_BUDGET_MS = 2_500;
const VOICE_AUDIO_CACHE_DIR = "/tmp/friday-voice/audio-cache";

interface SmokeMetrics {
  ok: boolean;
  failures: string[];
  model: string;
  voice: string;
  command: string;
  prompt: string;
  expectedTool: string;
  forceExpectedTool: boolean;
  directAction: boolean;
  noTool: boolean;
  thresholds: {
    firstAudioBudgetMs: number;
    timeoutMs: number;
  };
  readyMs?: number;
  createToResponseMs?: number;
  createToFunctionStartMs?: number;
  createToFunctionArgsDoneMs?: number;
  functionExecMs?: number;
  toolResultToFirstAudioMs?: number;
  createToFirstAudioMs?: number;
  createToDoneMs?: number;
  responseCount: number;
  audioChunks: number;
  audioBeforeFunction: number;
  emptyAudioRetryAttempts: number;
  localToolAck?: boolean;
  localToolAckCached?: boolean;
  localToolAckMs?: number;
  localToolAckBytes?: number;
  localTextSpeech?: boolean;
  localTextSpeechMs?: number;
  localFinalSpeech?: boolean;
  localFinalSpeechMs?: number;
  finalSpeechStartMs?: number;
  assistantTranscriptCount: number;
  assistantTranscript?: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolOutput?: string;
  imageCount?: number;
  imagePaths?: string[];
  jobId?: string;
  jobStatus?: string;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : fallback;
}

function toolOutput(result: ToolRunResult): string {
  return typeof result === "string" ? result : result.output;
}

function toolImages(result: ToolRunResult): Array<{ path: string; prompt?: string }> {
  return typeof result === "string" ? [] : (result.realtimeImages ?? []);
}

function findJobId(output: string): string | undefined {
  const match = output.match(/background job ([A-Za-z0-9_.-]+)/i);
  return match?.[1]?.replace(/[.,;:]+$/, "");
}

function includesComplete(status: string | undefined): boolean {
  return /\bcomplete\b/i.test(status ?? "");
}

function normalizeTranscript(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function repeatedSentence(text: string): string | undefined {
  const seen = new Set<string>();
  for (const raw of text.split(/(?<=[.!?])\s+/)) {
    const sentence = normalizeTranscript(raw);
    if (!sentence || sentence.length < 4) continue;
    if (seen.has(sentence)) return raw.trim();
    seen.add(sentence);
  }
  return undefined;
}

function speechCachePath(args: {
  model: string;
  voice: string;
  text: string;
  sampleRate: number;
  prefix?: string;
}): string {
  const hash = createHash("sha256")
    .update(
      JSON.stringify({
        model: args.model,
        voice: args.voice,
        text: args.text,
        rate: args.sampleRate,
        format: "pcm",
      }),
    )
    .digest("hex")
    .slice(0, 16);
  return path.join(VOICE_AUDIO_CACHE_DIR, `${args.prefix ?? "smoke-final"}-${hash}.pcm`);
}

async function synthesizeSmokeSpeech(
  cfg: ReturnType<typeof loadVoiceConfig>,
  textValue: string,
  prefix = "smoke-final",
): Promise<Buffer | null> {
  const text = textValue.trim();
  if (!text) return null;
  mkdirSync(VOICE_AUDIO_CACHE_DIR, { recursive: true });
  const file = speechCachePath({
    model: cfg.toolLocalAckModel,
    voice: cfg.voice,
    text,
    sampleRate: cfg.sampleRate,
    prefix,
  });
  if (existsSync(file)) {
    const cached = readFileSync(file);
    if (cached.byteLength > 0) return cached;
  }
  const response = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.openaiApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: cfg.toolLocalAckModel,
      voice: cfg.voice,
      input: text,
      response_format: "pcm",
    }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `speech ${response.status}: ${body.slice(0, 240) || response.statusText}`,
    );
  }
  const pcm = Buffer.from(await response.arrayBuffer());
  if (pcm.byteLength === 0) throw new Error("speech returned empty PCM");
  writeFileSync(file, pcm);
  return pcm;
}

function envBool(name: string): boolean {
  const raw = process.env[name];
  return raw === "1" || raw?.toLowerCase() === "true";
}

function directArgsFor(toolName: string, command: string): Record<string, unknown> {
  const raw = process.env.FRIDAY_VOICE_SMOKE_DIRECT_ARGS_JSON;
  if (raw) return JSON.parse(raw) as Record<string, unknown>;
  switch (toolName) {
    case "app_quick_switch":
      return {
        app: process.env.FRIDAY_VOICE_SMOKE_DIRECT_APP || "Slack",
        query: process.env.FRIDAY_VOICE_SMOKE_DIRECT_QUERY || "agent-test",
        shortcut: process.env.FRIDAY_VOICE_SMOKE_DIRECT_SHORTCUT || "cmd+k",
      };
    case "app_send_text":
      return {
        app: process.env.FRIDAY_VOICE_SMOKE_DIRECT_APP || "Slack",
        destination:
          process.env.FRIDAY_VOICE_SMOKE_DIRECT_DESTINATION || "agent-test",
        text:
          process.env.FRIDAY_VOICE_SMOKE_DIRECT_TEXT ||
          "friday draft smoke test",
        shortcut: process.env.FRIDAY_VOICE_SMOKE_DIRECT_SHORTCUT || "cmd+k",
        submit: envBool("FRIDAY_VOICE_SMOKE_DIRECT_SUBMIT"),
      };
    case "app_search_text":
      return {
        app: process.env.FRIDAY_VOICE_SMOKE_DIRECT_APP || "Music",
        text:
          process.env.FRIDAY_VOICE_SMOKE_DIRECT_TEXT ||
          "Numb by Linkin Park",
        shortcut: process.env.FRIDAY_VOICE_SMOKE_DIRECT_SHORTCUT || "cmd+l",
        submit:
          process.env.FRIDAY_VOICE_SMOKE_DIRECT_SUBMIT == null
            ? true
            : envBool("FRIDAY_VOICE_SMOKE_DIRECT_SUBMIT"),
        mode: process.env.FRIDAY_VOICE_SMOKE_DIRECT_MODE || "play",
        dry_run: envBool("FRIDAY_VOICE_SMOKE_DIRECT_DRY_RUN"),
      };
    case "browser_open_url":
      return {
        url: process.env.FRIDAY_VOICE_SMOKE_DIRECT_URL || "https://example.com",
        app: process.env.FRIDAY_VOICE_SMOKE_DIRECT_APP || "Google Chrome",
      };
    case "open_app":
      return {
        name: process.env.FRIDAY_VOICE_SMOKE_DIRECT_APP || "Google Chrome",
      };
    case "screen_see":
      return {
        prompt:
          "Inspect the current Mac screen and summarize the visible state briefly.",
      };
    case "run_shell":
    default:
      return { command };
  }
}

async function main(): Promise<void> {
  const cfg = loadVoiceConfig();
  const persona = await loadVoicePersona();
  const toolRunner = new ToolRunner(cfg);
  const command = process.env.FRIDAY_VOICE_SMOKE_COMMAND || DEFAULT_COMMAND;
  const expectedTool = process.env.FRIDAY_VOICE_SMOKE_EXPECTED_TOOL || "run_shell";
  const directAction = envBool("FRIDAY_VOICE_SMOKE_DIRECT_ACTION");
  const noTool = envBool("FRIDAY_VOICE_SMOKE_NO_TOOL");
  const imageAudio =
    process.env.FRIDAY_VOICE_SMOKE_IMAGE_AUDIO == null
      ? true
      : envBool("FRIDAY_VOICE_SMOKE_IMAGE_AUDIO");
  const forceExpectedTool = envBool("FRIDAY_VOICE_SMOKE_FORCE_EXPECTED_TOOL");
  const timeoutMs = envInt("FRIDAY_VOICE_SMOKE_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);
  const firstAudioBudgetMs = envInt(
    "FRIDAY_VOICE_SMOKE_FIRST_AUDIO_BUDGET_MS",
    DEFAULT_FIRST_AUDIO_BUDGET_MS,
  );
  const prompt =
    process.env.FRIDAY_VOICE_SMOKE_PROMPT ||
    [
      "Use the run_shell tool to run exactly this command:",
      command,
      "Do not explain before using the tool. After the tool result, say one very short acknowledgement.",
    ].join("\n");

  const startedAt = Date.now();
  let readyAt: number | undefined;
  let responseCreatedAt: number | undefined;
  let promptSentAt: number | undefined;
  let functionStartedAt: number | undefined;
  let functionArgsDoneAt: number | undefined;
  let functionExecStartedAt: number | undefined;
  let functionExecDoneAt: number | undefined;
  let toolResultSentAt: number | undefined;
  let firstAudioAt: number | undefined;
  let responseDoneAt: number | undefined;
  let responseCount = 0;
  let audioChunks = 0;
  let audioBeforeFunction = 0;
  const assistantTranscripts: string[] = [];
  let toolName: string | undefined;
  let toolArgs: Record<string, unknown> | undefined;
  let output = "";
  let images: Array<{ path: string; prompt?: string }> = [];
  let jobId: string | undefined;
  let jobStatus: string | undefined;
  let emptyAudioRetries = 0;
  let emptyAudioRetryAttempts = 0;
  let localToolAck = false;
  let localToolAckCached: boolean | undefined;
  let localToolAckMs: number | undefined;
  let localToolAckBytes: number | undefined;
  let localTextSpeech = false;
  let localTextSpoken = false;
  let localFinalSpeech = false;
  let localFinalSpoken = false;
  let localFinalSpeechMs: number | undefined;
  let realtimeResponseDone = false;
  let localTextSpeechMs: number | undefined;
  let finalSpeechAt: number | undefined;
  const failures: string[] = [];

  let doneResolve!: () => void;
  const done = new Promise<void>((resolve) => {
    doneResolve = resolve;
  });

  function maybeResolveDone(): void {
    if (!toolResultSentAt) return;
    if (localTextSpeech) {
      if (realtimeResponseDone && localTextSpoken) doneResolve();
      return;
    }
    if (localFinalSpeech) {
      if ((directAction || realtimeResponseDone) && localFinalSpoken) doneResolve();
      return;
    }
    if (realtimeResponseDone && (directAction || responseCount >= 2)) {
      doneResolve();
    }
  }

  async function handleLocalTextSpeech(text: string): Promise<void> {
    const speech = completeShortSentence(text);
    assistantTranscripts.push(speech);
    const dangling = danglingEnding(speech);
    if (dangling) failures.push(`Local text speech is incomplete: ${dangling}`);
    try {
      const started = Date.now();
      const pcm = await synthesizeSmokeSpeech(cfg, speech);
      localTextSpeechMs = Date.now() - started;
      if (!pcm) {
        failures.push("Local text speech synthesis returned no PCM.");
      } else {
        finalSpeechAt ??= Date.now();
        firstAudioAt ??= finalSpeechAt;
        audioChunks += Math.max(1, Math.ceil(pcm.byteLength / (cfg.sampleRate * 2 * 0.4)));
      }
    } catch (err) {
      failures.push(
        `Local text speech synthesis failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    } finally {
      localTextSpoken = true;
      responseDoneAt ??= Date.now();
      maybeResolveDone();
    }
  }

  async function playLocalToolAck(): Promise<void> {
    if (!cfg.toolLocalAckEnabled || localToolAck) return;
    const text = cfg.toolLocalAckText.trim() || "On it.";
    const file = speechCachePath({
      model: cfg.toolLocalAckModel,
      voice: cfg.voice,
      text,
      sampleRate: cfg.sampleRate,
      prefix: "tool-ack",
    });
    localToolAckCached = existsSync(file);
    const started = Date.now();
    try {
      const pcm = await synthesizeSmokeSpeech(cfg, text, "tool-ack");
      localToolAckMs = Date.now() - started;
      if (!pcm) {
        failures.push("Local tool ack synthesis returned no PCM.");
        return;
      }
      localToolAck = true;
      localToolAckBytes = pcm.byteLength;
      firstAudioAt ??= Date.now();
      audioChunks += Math.max(
        1,
        Math.ceil(pcm.byteLength / (cfg.sampleRate * 2 * 0.4)),
      );
    } catch (err) {
      localToolAckMs = Date.now() - started;
      failures.push(
        `Local tool ack unavailable: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  async function playLocalFinalSpeech(toolName: string, toolOutputValue: string): Promise<void> {
    localFinalSpeech = true;
    const speech = finalToolSpeech(toolName, toolOutputValue);
    assistantTranscripts.push(speech);
    const dangling = danglingEnding(speech);
    if (dangling) failures.push(`Local final speech is incomplete: ${dangling}`);
    const started = Date.now();
    try {
      const pcm = await synthesizeSmokeSpeech(cfg, speech, "final");
      localFinalSpeechMs = Date.now() - started;
      if (!pcm) {
        failures.push("Local final speech synthesis returned no PCM.");
        return;
      }
      finalSpeechAt ??= Date.now();
      firstAudioAt ??= finalSpeechAt;
      audioChunks += Math.max(
        1,
        Math.ceil(pcm.byteLength / (cfg.sampleRate * 2 * 0.4)),
      );
    } catch (err) {
      localFinalSpeechMs = Date.now() - started;
      failures.push(
        `Local final speech synthesis failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    } finally {
      localFinalSpoken = true;
      responseDoneAt ??= Date.now();
      maybeResolveDone();
    }
  }

  const client = new RealtimeClient(cfg, persona, toolDefsForConfig(cfg), {
    onAudioDelta: () => {
      audioChunks++;
      if (!directAction && !noTool && !functionStartedAt) audioBeforeFunction++;
      const now = Date.now();
      if (toolResultSentAt) finalSpeechAt ??= now;
      firstAudioAt ??= now;
    },
    onSpeechStarted: () => {},
    onResponseCreated: () => {
      responseCount++;
      responseCreatedAt ??= Date.now();
    },
    onAssistantTranscript: (text) => {
      const transcript = text.trim();
      if (transcript) assistantTranscripts.push(transcript);
    },
    onAssistantText: (text) => {
      const responseText = text.trim();
      if (!responseText) return;
      if (localTextSpeech) {
        void handleLocalTextSpeech(responseText);
      }
    },
    onFunctionCallStarted: (call) => {
      functionStartedAt ??= Date.now();
      toolName ??= call.name;
    },
    onFunctionCall: async ({ callId, name, args }) => {
      functionStartedAt ??= Date.now();
      functionArgsDoneAt = Date.now();
      toolName = name;
      toolArgs = args;
      functionExecStartedAt = Date.now();
      const result = await toolRunner.exec(name, args);
      functionExecDoneAt = Date.now();
      output = toolOutput(result);
      images = toolImages(result);
      jobId = findJobId(output);
      toolResultSentAt = Date.now();
      if (images.length > 0) {
        localTextSpeech = !imageAudio;
        client.sendFunctionResult(callId, output, false);
        for (const image of images) {
          client.sendImageInput(image.path, image.prompt);
        }
        client.createResponse(
          process.env.FRIDAY_VOICE_SMOKE_AFTER_IMAGE_INSTRUCTIONS ||
            "Use the attached image to answer in one complete sentence of eight words or fewer. End with a period. Do not read file paths or logs.",
          {
            queueIfActive: true,
            maxOutputTokens: cfg.maxOutputTokens,
            toolChoice: "none",
            outputModalities: imageAudio ? ["audio"] : ["text"],
          },
        );
      } else {
        client.sendFunctionResult(callId, output, false);
        await playLocalFinalSpeech(name, output);
      }
    },
    onResponseDone: ({ audioChunks: responseAudioChunks, expectedAudio }) => {
      realtimeResponseDone = true;
      if (!localTextSpeech && !localFinalSpeech) responseDoneAt = Date.now();
      if (noTool) {
        doneResolve();
        return;
      }
      if (
        toolResultSentAt &&
        !localTextSpeech &&
        expectedAudio &&
        responseAudioChunks === 0 &&
        emptyAudioRetries < 1
      ) {
        emptyAudioRetries++;
        emptyAudioRetryAttempts++;
        client.sendText(
          "The previous response produced no audible audio. Speak the acknowledgement now.",
          {
            instructions:
              "Speak aloud exactly one complete sentence now: It is handled now.",
            queueIfActive: true,
            maxOutputTokens: cfg.maxOutputTokens,
            toolChoice: "none",
            outputModalities: ["audio"],
          },
        );
        return;
      }
      emptyAudioRetries = 0;
      maybeResolveDone();
    },
    onError: (error) => {
      failures.push(`Realtime error: ${JSON.stringify(error)}`);
      doneResolve();
    },
    onClose: () => {},
  });

  client.connect();
  const readyDeadline = Date.now() + Math.min(timeoutMs, 8_000);
  while (!client.ready && Date.now() < readyDeadline) {
    await sleep(25);
  }
  if (!client.ready) {
    failures.push("Realtime session did not become ready.");
  } else {
    readyAt = Date.now();
    promptSentAt = Date.now();
    if (directAction) {
      toolName = expectedTool;
      toolArgs = directArgsFor(expectedTool, command);
      await playLocalToolAck();
      functionStartedAt = Date.now();
      functionArgsDoneAt = functionStartedAt;
      functionExecStartedAt = Date.now();
      const result = await toolRunner.exec(expectedTool, toolArgs);
      functionExecDoneAt = Date.now();
      output = toolOutput(result);
      images = toolImages(result);
      jobId = findJobId(output);
      toolResultSentAt = Date.now();
      if (images.length > 0) {
        localTextSpeech = !imageAudio;
        for (const image of images) client.sendImageInput(image.path, image.prompt);
        client.createResponse(
          process.env.FRIDAY_VOICE_SMOKE_AFTER_IMAGE_INSTRUCTIONS ||
            "Use the attached image to answer in one complete sentence of eight words or fewer. End with a period. Do not read file paths or logs.",
          {
            queueIfActive: true,
            maxOutputTokens: cfg.maxOutputTokens,
            toolChoice: "none",
            outputModalities: imageAudio ? ["audio"] : ["text"],
          },
        );
      } else {
        await playLocalFinalSpeech(expectedTool, output);
      }
    } else if (noTool) {
      client.sendText(prompt, {
        maxOutputTokens: cfg.shortReplyTokens,
        toolChoice: "none",
        outputModalities: ["audio"],
      });
    } else {
      await playLocalToolAck();
      client.sendText(prompt, {
        maxOutputTokens: cfg.maxToolCallTokens,
        toolChoice: forceExpectedTool
          ? { type: "function", name: expectedTool }
          : "required",
        outputModalities: undefined,
      });
    }
  }

  await Promise.race([done, sleep(timeoutMs)]);

  if (jobId) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      jobStatus = toolOutput(
        await toolRunner.exec("background_job_status", {
          job_id: jobId,
          tail_lines: 20,
        }),
      );
      if (includesComplete(jobStatus)) break;
      await sleep(250);
    }
  }

  client.close();

  if (!directAction && !noTool && !toolName) failures.push("No function call was produced.");
  if (toolName && toolName !== expectedTool) {
    failures.push(`Expected ${expectedTool}, got ${toolName}.`);
  }
  if (audioBeforeFunction > 0) {
    failures.push(`Audio started before tool call (${audioBeforeFunction} chunks).`);
  }
  if (!firstAudioAt) failures.push("No acknowledgement audio was produced.");
  const expectedResponses = noTool
    ? 1
    : localFinalSpeech
      ? directAction
        ? 0
        : 1
      : directAction
        ? 1 + emptyAudioRetryAttempts
        : 2 + emptyAudioRetryAttempts;
  if (responseCount > expectedResponses) {
    failures.push(
      `Unexpected extra responses: saw ${responseCount}, expected at most ${expectedResponses}.`,
    );
  }
  const allowedTranscriptCount = 1 + emptyAudioRetryAttempts;
  if (assistantTranscripts.length > allowedTranscriptCount) {
    failures.push(
      `Unexpected extra spoken acknowledgements: saw ${assistantTranscripts.length}, expected at most ${allowedTranscriptCount}.`,
    );
  }
  const duplicateSentence = repeatedSentence(assistantTranscripts.join(" "));
  if (duplicateSentence) {
    failures.push(`Repeated spoken sentence: ${duplicateSentence}`);
  }
  const transcriptEnding = danglingEnding(assistantTranscripts.join(" "));
  if (transcriptEnding) {
    failures.push(`Spoken response appears incomplete: ${transcriptEnding}.`);
  }
  if (promptSentAt && firstAudioAt && firstAudioAt - promptSentAt > firstAudioBudgetMs) {
    failures.push(
      `First audio took ${firstAudioAt - promptSentAt}ms, over ${firstAudioBudgetMs}ms budget.`,
    );
  }
  if (jobId && !includesComplete(jobStatus)) {
    failures.push(`Background job ${jobId} did not complete during smoke.`);
  }
  if (!jobId && output && /Still running|Started background job/i.test(output)) {
    failures.push("Tool output looked like a background job, but no job id was parsed.");
  }

  const metrics: SmokeMetrics = {
    ok: failures.length === 0,
    failures,
    model: cfg.model,
    voice: cfg.voice,
    command,
    prompt,
    expectedTool,
    forceExpectedTool,
    directAction,
    noTool,
    thresholds: { firstAudioBudgetMs, timeoutMs },
    ...(readyAt ? { readyMs: readyAt - startedAt } : {}),
    ...(promptSentAt && responseCreatedAt
      ? { createToResponseMs: responseCreatedAt - promptSentAt }
      : {}),
    ...(promptSentAt && functionStartedAt
      ? { createToFunctionStartMs: functionStartedAt - promptSentAt }
      : {}),
    ...(promptSentAt && functionArgsDoneAt
      ? { createToFunctionArgsDoneMs: functionArgsDoneAt - promptSentAt }
      : {}),
    ...(functionExecStartedAt && functionExecDoneAt
      ? { functionExecMs: functionExecDoneAt - functionExecStartedAt }
      : {}),
    ...(toolResultSentAt && (localToolAck ? finalSpeechAt : firstAudioAt)
      ? {
          toolResultToFirstAudioMs:
            (localToolAck ? finalSpeechAt! : firstAudioAt!) - toolResultSentAt,
        }
      : {}),
    ...(promptSentAt && firstAudioAt
      ? { createToFirstAudioMs: firstAudioAt - promptSentAt }
      : {}),
    ...(promptSentAt && responseDoneAt
      ? { createToDoneMs: responseDoneAt - promptSentAt }
      : {}),
    responseCount,
    audioChunks,
    audioBeforeFunction,
    emptyAudioRetryAttempts,
    ...(localToolAck ? { localToolAck } : {}),
    ...(localToolAckCached != null ? { localToolAckCached } : {}),
    ...(localToolAckMs != null ? { localToolAckMs } : {}),
    ...(localToolAckBytes != null ? { localToolAckBytes } : {}),
    ...(localTextSpeech ? { localTextSpeech } : {}),
    ...(localTextSpeechMs != null ? { localTextSpeechMs } : {}),
    ...(localFinalSpeech ? { localFinalSpeech } : {}),
    ...(localFinalSpeechMs != null ? { localFinalSpeechMs } : {}),
    ...(promptSentAt && finalSpeechAt
      ? { finalSpeechStartMs: finalSpeechAt - promptSentAt }
      : {}),
    assistantTranscriptCount: assistantTranscripts.length,
    ...(assistantTranscripts.length > 0
      ? { assistantTranscript: assistantTranscripts.join(" ").slice(0, 500) }
      : {}),
    ...(toolName ? { toolName } : {}),
    ...(toolArgs ? { toolArgs } : {}),
    ...(output ? { toolOutput: output } : {}),
    ...(images.length > 0
      ? {
          imageCount: images.length,
          imagePaths: images.map((image) => image.path),
        }
      : {}),
    ...(jobId ? { jobId } : {}),
    ...(jobStatus ? { jobStatus } : {}),
  };

  console.log(JSON.stringify(metrics, null, 2));
  process.exit(metrics.ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
