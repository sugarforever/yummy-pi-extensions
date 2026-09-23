export type SearchResult = {
  text: string;
  raw: unknown;
};

export interface SearchEngine {
  index(changedPaths?: readonly string[], options?: { signal?: AbortSignal }): Promise<void>;
  search(query: string, options?: { limit?: number; signal?: AbortSignal }): Promise<SearchResult>;
  close(): Promise<void>;
}

export type RuntimePhase = "idle" | "indexing" | "ready" | "updating" | "error" | "closed";

export type RuntimeStatus = {
  root: string;
  phase: RuntimePhase;
  error?: string;
  errorCode?: string;
  consecutiveFailures: number;
  lastIndexedAt?: string;
  pendingFiles: number;
  watcher: "disabled" | "starting" | "active" | "recovering" | "stopped";
};
