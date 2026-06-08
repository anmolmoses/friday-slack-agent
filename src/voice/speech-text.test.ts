import { describe, expect, it } from "bun:test";
import {
  completeShortSentence,
  danglingEnding,
  isLikelyNoiseTranscript,
} from "./speech-text.ts";

describe("voice speech text cleanup", () => {
  it("keeps short visual speech complete after word caps", () => {
    const speech = completeShortSentence(
      "The main window is a dark friday control plane page showing a graph.",
    );
    expect(speech).toBe("The main window is a dark friday control plane page.");
    expect(danglingEnding(speech)).toBeUndefined();
  });

  it("supports tighter visual caps without dangling endings", () => {
    const speech = completeShortSentence(
      "Expo dashboard shows a workflow YAML file and build annotations.",
      8,
    );
    expect(speech).toBe("Expo dashboard shows a workflow YAML file.");
    expect(danglingEnding(speech)).toBeUndefined();
  });

  it("detects incomplete endings", () => {
    expect(danglingEnding("The screen is showing.")).toBe(
      'dangling final word "showing"',
    );
    expect(danglingEnding("The screen is clear")).toBe(
      "missing sentence punctuation",
    );
  });

  it("filters tiny ambient transcript hallucinations", () => {
    expect(isLikelyNoiseTranscript("Men...")).toBe(true);
    expect(isLikelyNoiseTranscript("감사합니다.")).toBe(true);
    expect(isLikelyNoiseTranscript("どうですか?")).toBe(true);
    expect(isLikelyNoiseTranscript("um")).toBe(true);
  });

  it("keeps useful short voice commands and questions", () => {
    const likelyNeedsTool = (text: string) => /\b(open|run)\b/i.test(text);
    expect(isLikelyNoiseTranscript("open Chrome", { likelyNeedsTool })).toBe(false);
    expect(isLikelyNoiseTranscript("what is this?")).toBe(false);
    expect(isLikelyNoiseTranscript("Friday stop")).toBe(false);
    expect(isLikelyNoiseTranscript("thanks")).toBe(false);
  });
});
