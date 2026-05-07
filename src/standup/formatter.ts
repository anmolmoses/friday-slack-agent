import type { StandupSections, Topic } from "./types.ts";

/**
 * Render a single topic block:
 *
 *   > *Topic Name* ✅
 *   • task one ✅
 *   • task two
 */
function renderTopic(t: Topic): string {
  const allDone = t.tasks.length > 0 && t.tasks.every((task) => task.done);
  const topicTick = t.done || allDone ? " ✅" : "";
  const head = `> *${t.title}*${topicTick}`;
  const bullets = t.tasks.map((task) => {
    const tick = task.done ? " ✅" : "";
    return `• ${task.text}${tick}`;
  });
  return [head, ...bullets].join("\n");
}

/**
 * Render the full standup with two sections — Yesterday (with ✅ on completed
 * items) and Today (planned). Slack mrkdwn:
 *
 *   *Yesterday*
 *   > *Topic A* ✅
 *   • task one ✅
 *   • task two ✅
 *
 *   > *Topic B*
 *   • task three
 *
 *   *Today*
 *   > *Topic C*
 *   • task four
 *   • task five
 */
export function renderStandup(sections: StandupSections): string {
  const blocks: string[] = [];

  if (sections.yesterday.length > 0) {
    const body = sections.yesterday.map(renderTopic).join("\n\n");
    blocks.push(`*Yesterday*\n${body}`);
  }

  if (sections.today.length > 0) {
    const body = sections.today.map(renderTopic).join("\n\n");
    blocks.push(`*Today*\n${body}`);
  }

  return blocks.join("\n\n");
}

/** Best-effort parse — splits on the *Yesterday* / *Today* section headings. */
export function parseStandup(text: string): StandupSections {
  const sections: StandupSections = { yesterday: [], today: [] };

  const yesterdayIdx = text.search(/^\s*\*Yesterday\*/m);
  const todayIdx = text.search(/^\s*\*Today\*/m);

  if (yesterdayIdx >= 0 || todayIdx >= 0) {
    if (yesterdayIdx >= 0) {
      const end = todayIdx > yesterdayIdx ? todayIdx : text.length;
      sections.yesterday = parseTopics(text.slice(yesterdayIdx, end));
    }
    if (todayIdx >= 0) {
      sections.today = parseTopics(text.slice(todayIdx));
    }
  } else {
    // No section headings — treat the whole thing as today's plan.
    sections.today = parseTopics(text);
  }

  return sections;
}

function parseTopics(text: string): Topic[] {
  const topics: Topic[] = [];
  let cur: Topic | null = null;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    // Skip section headings
    if (/^\*(Yesterday|Today)\*$/i.test(line)) continue;

    const topicMatch = /^>\s*\*([^*]+)\*\s*(✅)?\s*$/.exec(line);
    if (topicMatch) {
      if (cur) topics.push(cur);
      cur = {
        title: topicMatch[1].trim(),
        done: !!topicMatch[2],
        tasks: [],
      };
      continue;
    }

    const taskMatch = /^[•\-*]\s*(.+?)\s*(✅)?\s*$/.exec(line);
    if (taskMatch && cur) {
      const text = taskMatch[1].replace(/\s*✅\s*$/, "").trim();
      cur.tasks.push({
        text,
        done: !!taskMatch[2] || /✅/.test(taskMatch[1]),
      });
    }
  }

  if (cur) topics.push(cur);
  return topics;
}
