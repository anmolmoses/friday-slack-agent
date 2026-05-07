export interface DeterministicAction {
  name: string;
  args: Record<string, unknown>;
}

export function likelyNeedsTool(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (!t) return false;
  if (isMetaCapabilityQuestion(t)) return false;
  if (wantsVisualScreenInspection(t)) return true;
  if (/\b(look up|google|search online|search the web|on the web|internet|latest|current|today|news)\b/.test(t)) {
    return true;
  }
  if (/\b(temperature|thermal|sensors?|fan speed|cpu temp|laptop'?s temp|battery health|latency|lag|delay|respond faster|response faster|audio faster|voice faster)\b/.test(t) || /\bpick up\b.*\bfaster\b/.test(t)) {
    return true;
  }
  if (isEngineeringDispatchPrompt(t)) return true;
  return /\b(open|opens|opening|launch|launches|launching|click|type|search|browse|screenshot|screen|camera|mouse|move|scroll|press|send|message|slack|chrome|browser|app|terminal|run|shell|command|test|build|fix|debug|commit|push|pull|review|repo|code|file|install|play|plays|playing|pause|pauses|resume|music|spotify|youtube)\b/.test(
    t,
  );
}

export function deterministicAction(
  text: string,
): DeterministicAction | undefined {
  const t = text.trim();
  const lower = t.toLowerCase();
  if (!t) return undefined;
  const multiStep = /\b(and|then|after that|send|message|type|click|search|use|play|go to channel)\b/i.test(
    t,
  );

  const commandMatch =
    t.match(/\b(?:run|execute)\s+(?:this\s+|the\s+)?(?:shell\s+)?command\s*:?\s+([\s\S]+)$/i) ??
    t.match(/\brun_shell\b[\s\S]*?\bcommand\s*:?\s+([\s\S]+)$/i);
  const command = commandMatch?.[1]?.trim();
  if (command && lower.includes("command")) {
    return { name: "run_shell", args: { command } };
  }

  if (isSystemTemperaturePrompt(t)) {
    return {
      name: "run_shell",
      args: {
        command:
          "battery_raw=$(ioreg -r -n AppleSmartBattery -a 2>/dev/null | plutil -extract 0.Temperature raw -o - - 2>/dev/null || true); if [ -n \"$battery_raw\" ] && [ \"$battery_raw\" -gt 0 ] 2>/dev/null; then awk -v t=\"$battery_raw\" 'BEGIN { printf \"Battery temperature: %.1f C\\n\", t / 100 }'; elif command -v osx-cpu-temp >/dev/null 2>&1; then osx-cpu-temp; elif command -v istats >/dev/null 2>&1; then istats; else pmset -g therm 2>/dev/null; fi",
      },
    };
  }

  const browserSubmit = browserSubmitAction(t);
  if (browserSubmit) return browserSubmit;

  const appSearchText = appSearchTextAction(t);
  if (appSearchText) return appSearchText;

  const mousePermission = mousePermissionAction(t);
  if (mousePermission) return mousePermission;

  const screenCapture = screenCaptureAction(t);
  if (screenCapture) return screenCapture;

  const screenBrief = screenBriefAction(t);
  if (screenBrief) return screenBrief;

  const appSendText = appSendTextAction(t);
  if (appSendText) return appSendText;

  const appQuickSwitch = appQuickSwitchAction(t);
  if (appQuickSwitch) return appQuickSwitch;

  if (isEngineeringDispatchPrompt(t)) {
    const dryRunPrompt = dryRunEngineeringDispatchPrompt(t);
    return {
      name: "dispatch_engineering",
      args: {
        prompt: dryRunPrompt ?? t,
        engine: /\b(claude|slack|cloud)\b/i.test(t) ? "claude" : "auto",
        ...(dryRunPrompt ? { dry_run: true } : {}),
      },
    };
  }

  const url = extractUrl(t);
  if (
    url &&
    /\b(open|go to|visit|load|browse)\b/i.test(t) &&
    !/\b(send|message|type|click|search|use|play)\b/i.test(t)
  ) {
    return {
      name: "browser_open_url",
      args: {
        url,
        app: /\bsafari\b/i.test(t) ? "Safari" : "Google Chrome",
      },
    };
  }

  const appAliases: Array<[RegExp, string]> = [
    [/\bchrome\b/i, "Google Chrome"],
    [/\bslack\b/i, "Slack"],
    [/\bterminal\b/i, "Terminal"],
    [/\bcursor\b/i, "Cursor"],
    [/\bfinder\b/i, "Finder"],
    [/\bsafari\b/i, "Safari"],
    [/\bmail\b/i, "Mail"],
    [/\bnotes\b/i, "Notes"],
    [/\bcalendar\b/i, "Calendar"],
    [/\b(settings|system settings)\b/i, "System Settings"],
  ];
  if (!multiStep && /\b(open|launch)\b/i.test(t)) {
    const app = appAliases.find(([pattern]) => pattern.test(t))?.[1];
    if (app) return { name: "open_app", args: { name: app } };
    const genericApp = extractSimpleAppName(t);
    if (genericApp) return { name: "open_app", args: { name: genericApp } };
  }

  return undefined;
}

export function favoriteSongAppAction(
  text: string,
  song: string,
): DeterministicAction | undefined {
  const resolvedSong = song.trim();
  if (!resolvedSong) return undefined;
  const match = text.match(
    /\b(?:open|launch|use|focus)\s+(?:the\s+)?(.+?)\s+(?:app(?:lication)?\s+)?(?:and|then|to)\s+(play|search(?:\s+(?:for|up))?|find|look up)\s+(?:(?:my|anmol'?s)\s+)?(?:favorite|favourite)\s+song\b/i,
  );
  if (!match) return undefined;
  const app = cleanAppName(match[1]);
  const verb = match[2] ?? "";
  if (!app) return undefined;
  return {
    name: "app_search_text",
    args: {
      app,
      text: resolvedSong,
      shortcut: "cmd+l",
      submit: true,
      mode: /\bplay\b/i.test(verb) ? "play" : "search",
      ...(/\bdry[- ]run\b/i.test(text) ? { dry_run: true } : {}),
    },
  };
}

export function preferredToolForAction(text: string): string | undefined {
  const t = text.trim().toLowerCase();
  if (!t) return undefined;
  if (isMetaCapabilityQuestion(t)) return undefined;
  if (likelyNeedsMemoryRecall(t) && likelyNeedsTool(t)) return "memory_search";
  if (/\bdispatch_engineering\b/.test(t)) return "dispatch_engineering";
  if (/\brun_shell\b/.test(t)) return "run_shell";
  if (/\bbrowser_open_url\b/.test(t)) return "browser_open_url";
  if (/\bapp_send_text\b/.test(t)) return "app_send_text";
  if (/\bapp_search_text\b/.test(t)) return "app_search_text";
  if (/\bapp_quick_switch\b/.test(t)) return "app_quick_switch";
  if (wantsVisualScreenInspection(t)) return "screen_see";
  if (appSendTextAction(text)) return "app_send_text";
  if (appSearchTextAction(text, { allowPersonalQuery: true })) {
    return "app_search_text";
  }
  if (appQuickSwitchAction(text)) return "app_quick_switch";
  if (screenBriefAction(text)) return "screen_brief";
  if (/\bscreen_brief\b/.test(t)) return "screen_brief";
  if (/\bscreen_see\b/.test(t)) return "screen_see";
  if (/\b(mouse|click|scroll|drag|screen|screenshot|see my screen|look at (my|the) screen)\b/.test(t)) {
    return "screen_see";
  }
  if (/\b(code|repo|pr|pull request|fix|debug|review|typecheck|build|test|commit|push)\b/.test(t)) {
    return "dispatch_engineering";
  }
  if (/\b(latency|lag|delay|respond faster|response faster|audio faster|voice faster)\b/.test(t) || /\bpick up\b.*\bfaster\b/.test(t)) {
    return "dispatch_engineering";
  }
  if (isSystemTemperaturePrompt(text)) return "run_shell";
  if (isEngineeringDispatchPrompt(text)) return "dispatch_engineering";
  if (/\b(shell|terminal|command line)\b/.test(t)) return "run_shell";
  if (/\b(run|execute)\b.*\b(command|script)\b/.test(t)) return "run_shell";
  if (browserSubmitAction(text)) return "browser_submit_text";
  if (/\b(open|go to|visit|load)\b.*\b(https?:\/\/|www\.|[a-z0-9-]+\.[a-z]{2,})\b/.test(t)) {
    return "browser_open_url";
  }
  if (/\b(search|look up|google)\b/.test(t) && /\b(web|internet|latest|current|today|news)\b/.test(t)) {
    return "web_search";
  }
  if (/\b(open|launch)\b.*\b(chrome|slack|terminal|cursor|finder|safari|mail|notes|calendar|settings)\b/.test(t)) {
    return "open_app";
  }
  if (extractSimpleAppName(text)) return "open_app";
  return undefined;
}

export function likelyNeedsPostVisionAction(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (!t) return false;
  return /\b(open|launch|click|type|search|browse|mouse|move|scroll|press|send|message|slack|chrome|browser|app|play|pause|music)\b/.test(
    t,
  );
}

export function likelyNeedsPostToolContinuation(args: {
  text: string;
  lastTool: string;
  toolCallCount: number;
}): boolean {
  const t = args.text.trim().toLowerCase();
  if (!t || args.toolCallCount >= 24) return false;
  const continuationTools = new Set([
    "memory_search",
    "engram_recall",
    "open_app",
    "app_quick_switch",
    "browser_open_url",
    "key_combo",
    "type_text",
    "mouse_control",
    "find_and_click",
    "app_search_text",
    "screen_see",
  ]);
  if (!continuationTools.has(args.lastTool)) return false;
  return /\b(and|then|after that|send|message|type|click|search|use|play|press|go to channel|channel)\b/.test(
    t,
  );
}

function isMetaCapabilityQuestion(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (!t) return false;
  if (/\bwhat can you do\b/.test(t)) return true;
  return /^\s*(can|could|would|are|do)\b.*\byou\b.*\b(change|modify|edit|update|access|control|use)\b.*\b(your own code|your code|yourself)\b.*\?\s*$/.test(
    t,
  );
}

function wantsVisualScreenInspection(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (!t) return false;
  return /\b(what am i looking at|what are we looking at|what(?:'s| is) (?:on|visible on) (?:my|the) screen|what do you see|tell me what you see|look at (?:my|the|this)?\s*screen|look at this|check (?:my|the) screen|can you see this|i want you to see|take a look|read (?:the )?(?:screen|visible text)|describe (?:my|the|this) screen|see (?:what|whether|if).*(?:screen|page|window|visible|gmail|youtube|chrome))\b/.test(
    t,
  );
}

function extractUrl(text: string): string | undefined {
  const match = text.match(
    /\b(?:https?:\/\/[^\s"'<>]+|www\.[^\s"'<>]+|[a-z0-9-]+\.[a-z]{2,}(?:\/[^\s"'<>]*)?)/i,
  );
  return match?.[0]?.replace(/[),.;:!?]+$/, "");
}

function browserSubmitAction(text: string): DeterministicAction | undefined {
  const query = extractSearchQuery(text);
  if (!query) return undefined;
  const lower = text.toLowerCase();
  const url =
    extractUrl(text) ??
    (/\bchatgpt\b/.test(lower)
      ? "chatgpt.com"
      : /\bgoogle\b/.test(lower)
        ? "google.com"
        : undefined);
  if (!url || !isKnownSearchSurface(url)) return undefined;
  if (
    !/\b(open|go to|visit|load|use|search|chrome|browser|chatgpt|google)\b/i.test(
      text,
    )
  ) {
    return undefined;
  }
  return {
    name: "browser_submit_text",
    args: {
      url,
      text: query,
      app: /\bsafari\b/i.test(text) ? "Safari" : "Google Chrome",
      submit: true,
      verify: wantsBrowserVerification(text),
    },
  };
}

function appQuickSwitchAction(text: string): DeterministicAction | undefined {
  if (!/\bslack\b/i.test(text)) return undefined;
  if (/\b(send|message|dm|post|reply|type)\b/i.test(text)) return undefined;
  const query = extractSlackDestination(text);
  if (!query) return undefined;
  return {
    name: "app_quick_switch",
    args: {
      app: "Slack",
      query,
      shortcut: "cmd+k",
    },
  };
}

function appSearchTextAction(
  text: string,
  opts: { allowPersonalQuery?: boolean } = {},
): DeterministicAction | undefined {
  const match = text.match(
    /\b(?:open|launch|use|focus)\s+(?:the\s+)?(.+?)\s+(?:app(?:lication)?\s+)?(?:and|then|to)\s+(search(?:\s+(?:for|up))?|find|look up|play)\s+([\s\S]+)$/i,
  );
  if (!match) return undefined;
  const app = cleanAppName(match[1]);
  const verb = match[2] ?? "";
  const query = cleanAppSearchText(match[3]);
  if (!app || !query) return undefined;
  if (!opts.allowPersonalQuery && isPersonalMemoryQuery(query)) {
    return undefined;
  }
  return {
    name: "app_search_text",
    args: {
      app,
      text: query,
      shortcut: "cmd+l",
      submit: true,
      mode: /\bplay\b/i.test(verb) ? "play" : "search",
    },
  };
}

function screenBriefAction(text: string): DeterministicAction | undefined {
  const t = text.trim().toLowerCase();
  if (!t) return undefined;
  if (wantsVisualScreenInspection(t)) {
    return {
      name: "screen_see",
      args: {
        prompt:
          "Inspect the current Mac screen and answer the user's visual question briefly.",
      },
    };
  }
  const asksSimpleScreen =
    /\b(current window|frontmost app|front window|what app(?:lication)? (?:is )?(?:open|frontmost)|which app(?:lication)? (?:is )?(?:open|frontmost))\b/.test(
      t,
    );
  if (!asksSimpleScreen) return undefined;
  if (
    /\b(click|press|type|move|scroll|drag|coordinate|button|field|input|find|locate|read|verify|confirm|results?|visible yet|screenshot|capture|take a screenshot|search|send|message|play|pause|open|launch|control|use)\b/.test(
      t,
    )
  ) {
    return undefined;
  }
  return { name: "screen_brief", args: {} };
}

function screenCaptureAction(text: string): DeterministicAction | undefined {
  const t = text.trim().toLowerCase();
  if (!t) return undefined;
  if (wantsVisualScreenInspection(t)) {
    return {
      name: "screen_see",
      args: {
        prompt:
          "Inspect the current Mac screen and answer the user's visual question briefly.",
      },
    };
  }
  const mentionsScreen =
    /\b(screen|screenshot|screen recording|visible text|visible on my screen|see my screen|look at my screen)\b/.test(
      t,
    );
  if (!mentionsScreen) return undefined;
  if (/\b(click|press|type|move|scroll|drag|control|mouse|send|message|play|pause|open|launch)\b/.test(t)) {
    return undefined;
  }
  const asksPermission =
    /\b(permission|access|enabled|working)\b/.test(t) ||
    /\bcan you\b.*\b(see|view|capture|take|get|use)\b.*\b(screen|screenshot)\b/.test(
      t,
    );
  if (asksPermission) {
    return {
      name: "screen_screenshot",
      args: { note: "friday-screen-permission-check" },
    };
  }
  if (/\b(take|capture|save)\b.*\bscreenshot\b/.test(t)) {
    return {
      name: "screen_screenshot",
      args: { note: "friday-requested-screenshot" },
    };
  }
  if (/\b(read|inspect|summari[sz]e|tell me|what text|visible text|describe|check if|verify|confirm|visible|locate)\b/.test(t)) {
    return {
      name: "screen_see",
      args: {
        prompt:
          "Inspect the current Mac screen and answer the user's visual question briefly.",
      },
    };
  }
  return undefined;
}

function mousePermissionAction(text: string): DeterministicAction | undefined {
  const t = text.trim().toLowerCase();
  if (!t || !/\b(mouse|pointer|cursor)\b/.test(t)) return undefined;
  if (!/\b(permission|access|enabled|working|ready|check|test|can you|able to)\b/.test(t)) {
    return undefined;
  }
  if (
    /\b(click|press|move|drag|scroll|type|control)\b/.test(t) &&
    !/\b(?:can you|you can|able to)\s+control\b/.test(t)
  ) {
    return undefined;
  }
  return { name: "mouse_control", args: { action: "check" } };
}

function appSendTextAction(text: string): DeterministicAction | undefined {
  if (!/\bslack\b/i.test(text)) return undefined;
  if (!/\b(send|message|post|reply|type|say)\b/i.test(text)) return undefined;
  const destination = extractSlackMessageDestination(text);
  if (!destination) return undefined;
  const message = extractSlackMessageText(text, destination);
  if (!message) return undefined;
  return {
    name: "app_send_text",
    args: {
      app: "Slack",
      destination,
      text: message,
      shortcut: "cmd+k",
      submit: true,
    },
  };
}

function extractSlackDestination(text: string): string | undefined {
  const patterns = [
    /\b(?:go to|jump to|switch to)\s+(?:the\s+)?(?:slack\s+)?(?:channel\s+)?#?([a-z0-9][a-z0-9._-]{1,80})\b/i,
    /\bopen\s+(?:the\s+)?(?:slack\s+)?channel\s+#?([a-z0-9][a-z0-9._-]{1,80})\b/i,
    /\b(?:channel|person|dm)\s+#?([a-z0-9][a-z0-9._-]{1,80})\b/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const raw = match?.[1]?.trim();
    if (!raw) continue;
    const cleaned = raw.replace(/[.!?,;:]+$/g, "");
    if (!cleaned || /^slack$/i.test(cleaned)) continue;
    return cleaned;
  }
  const inSlack = text.match(
    /\b#?([a-z0-9][a-z0-9._-]{1,80})\s+(?:in|on)\s+slack\b/i,
  )?.[1];
  return inSlack?.replace(/[.!?,;:]+$/g, "");
}

function extractSlackMessageDestination(text: string): string | undefined {
  const patterns = [
    /\b(?:to|in)\s+(?:the\s+)?(?:slack\s+)?(?:channel|dm|person)\s+#?([a-z0-9][a-z0-9._-]{1,80})\b/i,
    /\b(?:to|in)\s+#?([a-z0-9][a-z0-9._-]{1,80})\s+(?:in|on)\s+slack\b/i,
  ];
  for (const pattern of patterns) {
    const cleaned = cleanSlackDestination(text.match(pattern)?.[1]);
    if (cleaned) return cleaned;
  }
  return extractSlackDestination(text);
}

function extractSlackMessageText(
  text: string,
  destination: string,
): string | undefined {
  const quoted = text.match(/[“"']([^“"']{1,500})[”"']/)?.[1]?.trim();
  if (quoted && quoted.toLowerCase() !== destination.toLowerCase()) {
    return cleanSlackMessage(quoted);
  }

  const dest = escapeRegExp(destination);
  const patterns = [
    new RegExp(
      `\\b(?:send|post)\\s+(?:a\\s+)?(?:message|note)?\\s*(?:saying|that\\s+says|with\\s+text)?\\s*[:,-]?\\s+([\\s\\S]+?)\\s+(?:to|in)\\s+(?:the\\s+)?(?:slack\\s+)?(?:channel|dm|person)?\\s*#?${dest}\\b`,
      "i",
    ),
    new RegExp(
      `\\b(?:send|post)\\s+(?:a\\s+)?(?:message|note)\\s+(?:to|in)\\s+(?:the\\s+)?(?:slack\\s+)?(?:channel|dm|person)?\\s*#?${dest}\\b\\s*(?:saying|that\\s+says|with\\s+text|:)\\s+([\\s\\S]+)$`,
      "i",
    ),
    new RegExp(
      `\\b#?${dest}\\b[\\s\\S]*?\\b(?:send|post|say|type)\\s+(?:a\\s+)?(?:message|note)?\\s*(?:saying|that\\s+says|with\\s+text)?\\s*[:,-]?\\s+([\\s\\S]+)$`,
      "i",
    ),
  ];
  for (const pattern of patterns) {
    const message = cleanSlackMessage(text.match(pattern)?.[1]);
    if (message) return message;
  }
  return undefined;
}

function cleanSlackDestination(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const cleaned = raw.replace(/[.!?,;:]+$/g, "").trim();
  if (!cleaned || /^slack$/i.test(cleaned)) return undefined;
  return cleaned;
}

function cleanSlackMessage(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const cleaned = raw
    .replace(/^["'“”]+|["'“”]+$/g, "")
    .replace(/\s+(?:and\s+)?(?:tell me|let me know|say when).+$/i, "")
    .replace(/[.!?]+$/g, "")
    .trim();
  if (!cleaned || cleaned.length > 500) return undefined;
  if (/^(?:a\s+)?message$/i.test(cleaned)) return undefined;
  return cleaned;
}

function cleanAppName(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const cleaned = raw
    .replace(/[,;:]+$/g, "")
    .replace(/\s+(?:app|application|program)$/i, "")
    .trim();
  if (!cleaned || cleaned.length > 60) return undefined;
  const aliases: Array<[RegExp, string]> = [
    [/\bchrome\b/i, "Google Chrome"],
    [/\bsafari\b/i, "Safari"],
    [/\bmusic\b/i, "Music"],
    [/\bnotes\b/i, "Notes"],
    [/\bmail\b/i, "Mail"],
    [/\bslack\b/i, "Slack"],
    [/\bcursor\b/i, "Cursor"],
    [/\bterminal\b/i, "Terminal"],
  ];
  const alias = aliases.find(([pattern]) => pattern.test(cleaned))?.[1];
  if (alias) return alias;
  return cleaned
    .split(/\s+/)
    .map((word) => {
      if (/^[A-Z0-9&.-]+$/.test(word)) return word;
      return `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`;
    })
    .join(" ");
}

function cleanAppSearchText(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const cleaned = raw
    .replace(/^["'“”]+|["'“”]+$/g, "")
    .replace(/\s+(?:for me|please)$/i, "")
    .replace(/\s+(?:and\s+)?(?:tell me|let me know|say when).+$/i, "")
    .replace(/[.!?]+$/g, "")
    .trim();
  if (!cleaned || cleaned.length > 220) return undefined;
  return cleaned;
}

function isPersonalMemoryQuery(text: string): boolean {
  return /\b(my|favorite|favourite|usual|preferred|last time|same one|that song|it)\b/i.test(
    text,
  );
}

export function likelyNeedsMemoryRecall(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (!t) return false;
  return (
    /\b(my|anmol'?s)\s+(favorite|favourite|usual|preferred|preference|preferences|default|go-to)\b/.test(
      t,
    ) ||
    /\b(favorite|favourite)\s+(song|artist|band|album|movie|show|book|app|browser|editor|tool|language|framework|place|restaurant|food|drink|color|colour)\b/.test(
      t,
    ) ||
    /\b(what|which|who|where|when|how|why)\b[\s\S]{0,80}\b(did i|do i|i like|i prefer|i told you|i tell you|i said|i mentioned|told you|tell you|my usual|my preference|my favorite|my favourite|last time|same one|you (?:save|saved|remember)|we (?:save|saved|decided))\b/.test(
      t,
    ) ||
    /\b(why|when|how) (?:did|do) i (?:tell|say|mention|tell you)\b/.test(t) ||
    /\bwhat led\b/.test(t) ||
    /\b(do you remember|remember what|what did i say|what did we decide|what do you know about me|what do i like|what should you remember|how do you know)\b/.test(
      t,
    )
  );
}

function escapeRegExp(raw: string): string {
  return raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractSearchQuery(text: string): string | undefined {
  const matches = Array.from(
    text.matchAll(
      /\bsearch\s+for\s+(.+?)(?=(?:\.\s|,\s*(?:and\s+)?tell|\s+and\s+tell|\s+when\s+|$))/gi,
    ),
  );
  const raw = matches.at(-1)?.[1]?.trim();
  if (!raw) return undefined;
  const cleaned = raw
    .replace(/^(?:bar\s+to\s+)?search\s+for\s+/i, "")
    .replace(
      /\s+(?:in|inside|using|with|on)\s+(?:the\s+)?(?:chatgpt|google|browser|site|page)?\s*(?:search\s+)?(?:bar|box|field)\s*[.!?]*$/i,
      "",
    )
    .replace(/^["'“”]+|["'“”]+$/g, "")
    .replace(/[.!?]+$/g, "")
    .trim();
  if (!cleaned || cleaned.length > 180) return undefined;
  return cleaned;
}

function isKnownSearchSurface(url: string): boolean {
  const normalized = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  try {
    const host = new URL(normalized).hostname.replace(/^www\./i, "").toLowerCase();
    return [
      "chatgpt.com",
      "google.com",
      "duckduckgo.com",
      "bing.com",
      "youtube.com",
      "github.com",
      "npmjs.com",
    ].some((known) => host === known || host.endsWith(`.${known}`));
  } catch {
    return false;
  }
}

function wantsBrowserVerification(text: string): boolean {
  return /\b(tell me when|let me know when|verify|confirm|check if|make sure|wait until|when (?:the )?(?:search )?results?|results? (?:are|is) visible|visible|shown?|loaded|opened)\b/i.test(
    text,
  );
}

function isEngineeringDispatchPrompt(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (!t) return false;
  if (/\b(latency|lag|delay|respond faster|response faster|audio faster|voice faster)\b/.test(t) || /\bpick up\b.*\bfaster\b/.test(t)) {
    return true;
  }
  if (/\bdispatch_engineering\b/.test(t)) return true;
  if (/\bgithub\.com\/[^\s]+\/[^\s]+\/(?:pull|issues?)\b/.test(t)) return true;
  if (/\b(pr|pull request)\s*#?\d+\b/.test(t)) return true;
  if (/\b(commit|push|pull request|open a pr|create a pr|merge)\b/.test(t)) {
    return true;
  }
  if (/\b(typecheck|lint|unit tests?|test suite|ci|build|release)\b/.test(t)) {
    return true;
  }
  const engineeringVerb =
    /\b(fix|debug|review|implement|build|refactor|ship|patch|investigate|update|add|write|run|create|make|change|modify|edit|wire|connect|integrate|set up|setup|scaffold|remove|delete|rename|improve|optimize|deploy|migrate|diagnose|verify|check)\b/.test(
      t,
    );
  const engineeringObject =
    /\b(code|repo|repository|backend|frontend|mobile|web|admin|api|endpoint|route|controller|service|component|page|ui|hook|server|client|expo|ios|android|database|db|schema|migration|auth|login|socket|websocket|queue|worker|logs?|bug|feature|tests?|typecheck|build|pr|pull request|branch|file|daemon|voice route|realtime)\b/.test(
      t,
    ) || /\b[a-z0-9]+-[a-z0-9-]+\b/.test(t);
  return engineeringVerb && engineeringObject;
}

function dryRunEngineeringDispatchPrompt(text: string): string | undefined {
  const match = text.match(
    /^\s*(?:please\s+)?(?:dry[- ]run|probe|readiness)\s+(?:a\s+)?(?:local\s+)?(?:codex\s+)?engineering\s+dispatch\s*:?\s*([\s\S]+)$/i,
  );
  const prompt = match?.[1]?.trim();
  return prompt || undefined;
}

function isSystemTemperaturePrompt(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (!/\b(temperature|thermal|sensors?|fan speed|cpu temp|laptop'?s temp)\b/.test(t)) {
    return false;
  }
  return /\b(check|what|how|show|get|read|tell|current|status|laptop|mac|system|cpu|battery)\b/.test(
    t,
  );
}

function extractSimpleAppName(text: string): string | undefined {
  const match = text.match(
    /^\s*(?:please\s+)?(?:open|launch|start|focus)\s+(?:the\s+)?(.+?)\s*$/i,
  );
  if (!match) return undefined;
  const raw = match[1]
    ?.replace(/\s+(?:app|application|program)$/i, "")
    .replace(/[.!?]+$/, "")
    .trim();
  if (!raw) return undefined;
  if (raw.length > 60) return undefined;
  if (
    /\b(url|website|page|file|folder|repo|repository|pull request|pr|command|script|test|build|bug|issue)\b/i.test(
      raw,
    )
  ) {
    return undefined;
  }
  if (/^my\b/i.test(raw)) return undefined;
  return raw
    .split(/\s+/)
    .map((word) => {
      if (/^[A-Z0-9&.-]+$/.test(word)) return word;
      return `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`;
    })
    .join(" ");
}
