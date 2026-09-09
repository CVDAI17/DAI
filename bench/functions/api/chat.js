// Cloudflare Pages Function. Deployed automatically with the site.
// Set ANTHROPIC_API_KEY as an encrypted environment variable in the Pages project.
// The key never reaches the browser.

const MODELS = {
  // Voice: latency is the whole experience. Fast model, short answers.
  voice: { model: "claude-sonnet-5", max_tokens: 400 },
  // Brief: runs once, nobody is waiting. Spend the thinking here.
  brief: { model: "claude-opus-5", max_tokens: 1200 },
};

const VOICE_SYSTEM = `You are the assistant behind Bench, a personal command center. You can see the owner's open items, deadlines and tracked numbers.

This question was spoken aloud and your answer is read back out loud. So:
- A few sentences. Never more than five.
- Plain spoken sentences only. No lists, no headers, no markdown, no parentheses, no symbols that don't read aloud. Write dates the way a person says them.
- Lead with the answer. No preamble, no restating the question.

Be concrete and honest. Say what's actually urgent and what can wait. If something on the board looks wrong or the board doesn't contain enough to answer, say so plainly. Never invent an item, date or number that isn't there. No cheerleading.

You can search the web. Use it when the answer depends on something current that isn't on the board — a price, a fact, what's open, what happened. Don't search for anything the board already answers; searching costs a second or two of silence, and silence is expensive when someone is standing there waiting. Never read a URL aloud. Say where something came from in words, like "according to their site."`;

const BRIEF_SYSTEM = `You are the assistant behind Bench, a personal command center. You can see the owner's open items, deadlines and tracked numbers.

Write a morning brief. Lead with anything overdue or due within three days. Then what's worth doing today and why, and what can safely wait. If a tracked number has moved in a way that matters, say so and say what it implies.

A few short paragraphs of plain prose. No headers, no bullet lists, no markdown. Speak plainly and directly, the way a sharp colleague would. Be honest about what's actually urgent versus what merely feels urgent, and say when there isn't enough on the board to judge something. Never invent items, dates or numbers. No filler, no encouragement for its own sake.`;

export async function onRequestPost({ request, env }) {
  if (!env.ANTHROPIC_API_KEY) {
    return json({ error: "Server is missing its API key." }, 500);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Bad request." }, 400);
  }

  const mode = body.mode === "brief" ? "brief" : "voice";
  const cfg = MODELS[mode];
  const board = String(body.board || "").slice(0, 20000);
  const messages = Array.isArray(body.messages) ? body.messages.slice(-16) : [];

  if (mode === "voice" && messages.length === 0) {
    return json({ error: "Nothing to answer." }, 400);
  }

  // The system prompt and the board are the stable prefix, so they get cached.
  // Cache hits bill at a tenth of input price and shave time off the first token.
  const system = [
    { type: "text", text: mode === "brief" ? BRIEF_SYSTEM : VOICE_SYSTEM },
    {
      type: "text",
      text: `Current board:\n\n${board}`,
      cache_control: { type: "ephemeral" },
    },
  ];

  const payload = {
    model: cfg.model,
    max_tokens: cfg.max_tokens,
    system,
    stream: true,
    tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }],
    messages: mode === "brief"
      ? [{ role: "user", content: "Write my brief for today." }]
      : messages,
  };

  const upstream = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(payload),
  });

  if (!upstream.ok) {
    const detail = await upstream.text();
    return json({ error: "Upstream error", status: upstream.status, detail: detail.slice(0, 500) }, 502);
  }

  // Pass the stream straight through so the browser can start speaking
  // before the model has finished writing.
  return new Response(upstream.body, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}
