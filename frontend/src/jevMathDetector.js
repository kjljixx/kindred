/** Ask Jev to approve potential math ranges proposed by the local detector. */
export async function classifyMathWithJev(
  text,
  candidates = undefined,
  fetchImpl = fetch,
) {
  const response = await fetchImpl("/api/math/detect", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, candidates }),
  });

  if (!response.ok) {
    throw new Error(`Math detection failed (${response.status})`);
  }

  const { ranges } = await response.json();
  return {
    ranges,
    expressions: ranges.map((range) => text.slice(range.start, range.end)),
  };
}
