// Paste this file into the browser console on a local Kindred chat thread.
// It intercepts only /api/chat, so no model request is sent. XML anchors
// exercise incremental streaming; unmatched anchors render as static text.
// Delete the benchmark message afterward if you do not want it in the saved chat.
(async () => {
  const input = document.querySelector("#chat-input");
  const composer = document.querySelector("#chat-composer");
  const thread = document.querySelector("#feedback");
  if (!input || !composer || !thread || composer.hidden) {
    throw new Error("Open a draft's chat thread before running the benchmark.");
  }

  const chunks = 1200;
  const intervalMs = 8;
  const includeAnchors = true;
  const mention = '<mention start="0" end="4"><original>text</original><prefix></prefix><suffix></suffix></mention>';
  const suggestion = '<suggestion start="0" end="4"><original>text</original><prefix></prefix><suffix></suffix><replacement>clearer text</replacement></suggestion>';
  const deltas = Array.from({ length: chunks }, (_, index) => {
    if (!includeAnchors) return "A short streaming sentence with **bold text**. ";
    if (index % 4 === 0) {
      return "A short streaming sentence with **bold text**. ";
    }
    if (index % 4 === 1) {
      return `Consider ${mention.slice(0, 50)}`;
    }
    if (index % 4 === 2) {
      return `${mention.slice(50)} in this passage. Try ${suggestion} here. `;
    }
    return `Or ${suggestion}. `;
  });
  const reply = deltas.join("");
  const originalFetch = window.fetch;
  const originalBenchmark = window.__kindredChatBenchmark;
  const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, "innerHTML");
  const encoder = new TextEncoder();
  const sent = [];
  const renders = [];
  const phases = {};
  const longTasks = [];
  let hiddenAtAnyPoint = document.hidden;
  let requestStarted;
  let finished;

  const trackVisibility = () => {
    hiddenAtAnyPoint ||= document.hidden;
  };
  document.addEventListener("visibilitychange", trackVisibility);
  window.__kindredChatBenchmark = (name, ms) => {
    (phases[name] ||= []).push(ms);
  };

  const observer = typeof PerformanceObserver === "undefined" ? null : new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) longTasks.push(entry.duration);
  });
  try {
    observer?.observe({ type: "longtask", buffered: false });
  } catch {
    observer?.disconnect();
  }

  Object.defineProperty(Element.prototype, "innerHTML", {
    ...descriptor,
    set(value) {
      if (this !== thread) return descriptor.set.call(this, value);
      const started = performance.now();
      const result = descriptor.set.call(this, value);
      renders.push({ at: performance.now(), ms: performance.now() - started });
      return result;
    },
  });

  window.fetch = function (resource, options) {
    if (String(resource) !== "/api/chat") return originalFetch.apply(this, arguments);
    requestStarted = performance.now();
    let count = 0;
    let timer;
    const stream = new ReadableStream({
      start(controller) {
        timer = setInterval(() => {
          if (count < chunks) {
            sent.push(performance.now());
            controller.enqueue(encoder.encode(JSON.stringify({ type: "delta", delta: deltas[count] }) + "\n"));
            count++;
          } else {
            controller.enqueue(encoder.encode(JSON.stringify({
              type: "done", reply, cost: 0,
            }) + "\n"));
            controller.close();
            clearInterval(timer);
          }
        }, intervalMs);
      },
      cancel() {
        clearInterval(timer);
      },
    });
    return Promise.resolve(new Response(stream, {
      headers: { "Content-Type": "application/x-ndjson" },
    }));
  };

  try {
    input.value = "Offline streaming benchmark";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    composer.requestSubmit();
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Chat did not complete within 120 seconds")), 120000);
      const check = setInterval(() => {
        if (!requestStarted || composer.getAttribute("aria-busy") === "true") return;
        clearInterval(check);
        clearTimeout(timeout);
        finished = performance.now();
        resolve();
      }, 20);
    });
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const durations = renders.map((render) => render.ms).sort((a, b) => a - b);
    const percentile = (p) => durations[Math.floor((durations.length - 1) * p)] || 0;
    const gaps = sent.slice(1).map((at, i) => at - sent[i]);
    const maxGapMs = Math.max(0, ...gaps);
    const phaseStats = Object.fromEntries(Object.entries(phases).map(([name, values]) => [
      name, {
        count: values.length,
        totalMs: Math.round(values.reduce((sum, ms) => sum + ms, 0)),
        maxMs: +Math.max(...values).toFixed(1),
      },
    ]));
    const report = {
      chunks: sent.length,
      intervalMs,
      responseChars: reply.length,
      includeAnchors,
      mentionTokens: includeAnchors ? chunks / 4 : 0,
      suggestionTokens: includeAnchors ? chunks / 2 : 0,
      renderedMentionButtons: thread.querySelectorAll('[data-chat-action="mention"]').length,
      renderedSuggestionButtons: thread.querySelectorAll('[data-chat-action="suggest"]').length,
      renderedUnmatchedMentions: thread.querySelectorAll(".chat-mention.suggestion-static").length,
      renderedUnmatchedSuggestions: thread.querySelectorAll(".chat-suggestion-replaced").length,
      elapsedMs: Math.round(finished - requestStarted),
      threadRebuilds: renders.length,
      totalRebuildMs: Math.round(durations.reduce((sum, ms) => sum + ms, 0)),
      medianRebuildMs: +percentile(0.5).toFixed(1),
      p95RebuildMs: +percentile(0.95).toFixed(1),
      maxRebuildMs: +percentile(1).toFixed(1),
      maxDeliveryGapMs: Math.round(maxGapMs),
      maxGapAfterChunk: gaps.indexOf(maxGapMs) + 1,
      tabHiddenDuringRun: hiddenAtAnyPoint,
      longTasks: longTasks.length,
    };
    console.table(report);
    console.table(phaseStats);
    return { report, phaseStats };
  } finally {
    window.fetch = originalFetch;
    if (originalBenchmark === undefined) delete window.__kindredChatBenchmark;
    else window.__kindredChatBenchmark = originalBenchmark;
    Object.defineProperty(Element.prototype, "innerHTML", descriptor);
    observer?.disconnect();
    document.removeEventListener("visibilitychange", trackVisibility);
  }
})();
