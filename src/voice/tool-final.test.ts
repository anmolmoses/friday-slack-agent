import { describe, expect, it } from "bun:test";
import { finalToolInstructions, finalToolSpeech } from "./tool-final.ts";

describe("voice final tool speech", () => {
  it("keeps web search results short enough for speech", () => {
    expect(
      finalToolSpeech(
        "web_search",
        [
          "1. Realtime and audio | OpenAI API",
          "https://developers.openai.com/api/docs/guides/realtime",
          "Realtime transcription and audio output docs.",
        ].join("\n"),
      ),
    ).toBe("Top result is Realtime and audio.");
  });

  it("speaks shell temperature directly", () => {
    expect(
      finalToolSpeech("run_shell", "Battery temperature: 31.2 C\n"),
    ).toBe("Battery temperature is 31.2 degrees Celsius.");
  });

  it("speaks app quick switches as completed navigation", () => {
    expect(
      finalToolSpeech(
        "app_quick_switch",
        "Quick switched Slack to agent-test using cmd+k.",
      ),
    ).toBe("I jumped there.");
  });

  it("speaks fast screen briefs tersely", () => {
    expect(
      finalToolSpeech(
        "screen_brief",
        "Frontmost app: Visual Studio Code\nWindow title: Friday - Git diff",
      ),
    ).toBe("Visual Studio Code is frontmost: Friday - Git diff.");
  });

  it("speaks app text sends and drafts tersely", () => {
    expect(
      finalToolSpeech(
        "app_send_text",
        "Sent app text in Slack to agent-test: hello",
      ),
    ).toBe("I sent it.");
    expect(
      finalToolSpeech(
        "app_send_text",
        "Prepared app text in Slack to agent-test without sending: hello",
      ),
    ).toBe("I drafted it.");
  });

  it("speaks generic app search and play actions tersely", () => {
    expect(
      finalToolSpeech(
        "app_search_text",
        "App search text submitted in Google Chrome: OpenAI realtime docs using cmd+l.",
      ),
    ).toBe("I searched it in the app.");
    expect(
      finalToolSpeech(
        "app_search_text",
        "App play text submitted in Music: Numb by Linkin Park using cmd+l.",
      ),
    ).toBe("I started it in the app.");
    expect(
      finalToolSpeech(
        "app_search_text",
        [
          "App play text submitted in Music: Numb by Linkin Park using cmd+l.",
          "Started background job 2026-app-play.",
        ].join("\n"),
      ),
    ).toBe("I started it in the app.");
  });

  it("uses exact instructions for realtime speech", () => {
    expect(finalToolInstructions("open_app", "Opened Music.")).toBe(
      "Speak aloud exactly: It is open now.",
    );
  });

  it("does not read screen permission logs aloud", () => {
    expect(
      finalToolSpeech(
        "screen_see",
        "Screen Recording permission is not enabled. Open Privacy_ScreenCapture.",
      ),
    ).toBe("Screen Recording still needs a fresh Terminal restart.");
  });
});
