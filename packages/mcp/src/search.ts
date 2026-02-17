import type { DocPage, SearchResult } from "./types.js";

export function searchDocs(pages: DocPage[], query: string): SearchResult[] {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0);

  if (terms.length === 0) return [];

  const scored: SearchResult[] = [];

  for (const page of pages) {
    const titleLower = page.title.toLowerCase();
    const contentLower = page.content.toLowerCase();
    let score = 0;
    let firstMatchIndex = -1;

    for (const term of terms) {
      // Title matches weighted 3x
      let idx = 0;
      while ((idx = titleLower.indexOf(term, idx)) !== -1) {
        score += 3;
        idx += term.length;
      }

      // Content matches
      idx = 0;
      while ((idx = contentLower.indexOf(term, idx)) !== -1) {
        score += 1;
        if (firstMatchIndex === -1) firstMatchIndex = idx;
        idx += term.length;
      }
    }

    if (score === 0) continue;

    // Extract snippet around first match
    let snippet: string;
    if (firstMatchIndex !== -1) {
      const start = Math.max(0, firstMatchIndex - 80);
      const end = Math.min(page.content.length, firstMatchIndex + 120);
      snippet =
        (start > 0 ? "..." : "") +
        page.content.slice(start, end).trim() +
        (end < page.content.length ? "..." : "");
    } else {
      snippet = page.content.slice(0, 200).trim() + "...";
    }

    scored.push({ slug: page.slug, title: page.title, snippet, score });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 5);
}
