export interface DocPage {
  slug: string;
  title: string;
  content: string;
}

export interface SearchResult {
  slug: string;
  title: string;
  snippet: string;
  score: number;
}
