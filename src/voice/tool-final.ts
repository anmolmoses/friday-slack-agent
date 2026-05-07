export function finalToolSpeech(toolName: string, output: string): string {
  const normalized = output.replace(/\s+/g, " ").trim();
  if (!normalized) return "Done.";

  if (/^App search text/i.test(normalized)) {
    return /without submitting/i.test(normalized)
      ? "I typed it in the app."
      : "I searched it in the app.";
  }
  if (/^App play text/i.test(normalized)) {
    return /without submitting/i.test(normalized)
      ? "I typed it in the app."
      : "I started it in the app.";
  }
  if (/Still running|Started background job/i.test(normalized)) {
    return "I started it in the background.";
  }
  if (/local Codex dispatch prepared|Started a local Codex session/i.test(normalized)) {
    return "I started Codex on it.";
  }
  if (/^Opened\b/i.test(normalized)) {
    return "It is open now.";
  }
  if (/Submitted browser text/i.test(normalized)) {
    return "I submitted it in the browser.";
  }
  if (/Quick switched/i.test(normalized)) {
    return "I jumped there.";
  }
  if (/^(Sent|Prepared) app text/i.test(normalized)) {
    return /^Prepared app text/i.test(normalized)
      ? "I drafted it."
      : "I sent it.";
  }
  if (/Screen captured and attached for vision/i.test(normalized)) {
    return "I can see the screen now.";
  }
  if (toolName === "screen_brief") {
    return summarizeScreenBrief(output);
  }
  if (/Screen Recording permission|CGRequestScreenCaptureAccess|Privacy_ScreenCapture/i.test(normalized)) {
    return "Screen Recording still needs a fresh Terminal restart.";
  }
  if (/Accessibility permission required|Privacy_Accessibility/i.test(normalized)) {
    return "Accessibility permission is still missing for control.";
  }

  if (toolName === "web_search") {
    return summarizeWebSearch(normalized);
  }
  if (toolName === "run_shell") {
    return summarizeShell(normalized);
  }
  if (toolName === "mouse_control") {
    return /^Mouse helper ready/i.test(normalized)
      ? "Mouse control is ready."
      : "Mouse control ran.";
  }

  return "Done.";
}

export function finalToolInstructions(toolName: string, output: string): string {
  return `Speak aloud exactly: ${finalToolSpeech(toolName, output)}`;
}

function summarizeWebSearch(output: string): string {
  if (/timed out/i.test(output)) return "The live search is slow right now.";
  if (/failed/i.test(output)) return "The live search failed.";
  if (/No parseable search results/i.test(output)) {
    return "I could not parse live search results.";
  }
  const firstTitle = output.match(/(?:^|\s)1\.\s*([^\n]+?)(?:\s+https?:\/\/|\s{2,}|$)/i)?.[1] ??
    output.match(/(?:^|\s)1\.\s*([^|]+?)(?:\s+\||$)/i)?.[1];
  const title = cleanTitle(firstTitle ?? "");
  if (!title) return "I found live search results.";
  return `Top result is ${title}.`;
}

function summarizeShell(output: string): string {
  const batteryTemp = output.match(/Battery temperature:\s*([0-9]+(?:\.[0-9]+)?)\s*C/i)?.[1];
  if (batteryTemp) return `Battery temperature is ${batteryTemp} degrees Celsius.`;

  const temp = output.match(/(?:temperature|thermal|cpu).*?([0-9]+(?:\.[0-9]+)?)\s*(?:C|degrees)/i)?.[1];
  if (temp) return `Temperature is ${temp} degrees Celsius.`;

  if (/^\[exit\s+\d+\]/i.test(output)) return "The command failed.";
  if (/\(ok, no output\)/i.test(output)) return "The command finished.";

  const firstLine = output.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  const summary = cleanTitle(firstLine ?? "");
  if (!summary) return "The command finished.";
  return `The command returned ${summary}.`;
}

function summarizeScreenBrief(output: string): string {
  if (/Accessibility permission required|Privacy_Accessibility/i.test(output)) {
    return "Accessibility permission is still missing for control.";
  }
  const app = cleanTitle(output.match(/Frontmost app:[ \t]*([^\r\n]+)/i)?.[1] ?? "");
  const windowTitle = cleanTitle(output.match(/Window title:[ \t]*([^\r\n]+)/i)?.[1] ?? "");
  if (app && windowTitle && !/^unavailable$/i.test(windowTitle)) {
    return `${app} is frontmost: ${windowTitle}.`;
  }
  if (app) return `${app} is frontmost.`;
  return "I could not identify the front window.";
}

function cleanTitle(raw: string): string {
  const noUrl = raw.replace(/https?:\/\/\S+/g, "").trim();
  const beforePipe = noUrl.split(/\s+\|\s+/)[0]?.trim() ?? noUrl;
  const words = beforePipe
    .replace(/[`*_#<>{}[\]]/g, "")
    .replace(/[.!?;:]+$/g, "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 9)
    .join(" ");
  return words || "";
}
