import { crawlSource, type CrawlSourceInput, type CrawlSourceResult } from "./crawlSource.js";
import { indexCrawlResult, type EmbeddingProvider, type IndexCrawlSummary } from "./indexDocument.js";

export type SyncSourceInput = CrawlSourceInput & {
  embedder: EmbeddingProvider;
  embeddingModel: string;
};

export type SyncSourceDependencies = {
  crawl?: (input: CrawlSourceInput) => Promise<CrawlSourceResult>;
  index?: (input: {
    crawlResult: CrawlSourceResult;
    repository: SyncSourceInput["repository"];
    embedder: EmbeddingProvider;
    embeddingModel: string;
    signal?: AbortSignal;
  }) => Promise<IndexCrawlSummary>;
};

/** Crawl and index one validated source; source state is committed by the existing indexer. */
export async function syncSource(
  input: SyncSourceInput,
  dependencies: SyncSourceDependencies = {},
): Promise<IndexCrawlSummary> {
  const crawl = dependencies.crawl ?? crawlSource;
  const index = dependencies.index ?? indexCrawlResult;
  const { embedder, embeddingModel, ...crawlInput } = input;
  const crawlResult = await crawl(crawlInput);
  return index({
    crawlResult,
    repository: crawlInput.repository,
    embedder,
    embeddingModel,
    signal: crawlInput.signal,
  });
}
