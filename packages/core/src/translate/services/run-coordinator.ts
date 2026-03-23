export type CoordinatorPage = {
  taskId: string;
  hasPendingChunks(): boolean;
  startNextChunk(): Promise<void>;
  onChunkSettled(): void;
};

type ActiveCoordinatorPage = {
  page: CoordinatorPage;
  runningCount: number;
};

export async function runWithCoordinator(options: {
  concurrency: number;
  pages: CoordinatorPage[];
}): Promise<void> {
  const concurrency = Math.max(1, options.concurrency);
  const queuedPages = [...options.pages];
  const activePages: ActiveCoordinatorPage[] = [];
  const inFlight = new Set<Promise<void>>();
  let borrowCursor = 0;

  while (
    queuedPages.length > 0 ||
    activePages.length > 0 ||
    inFlight.size > 0
  ) {
    pruneCompletedPages(activePages);
    activatePages(queuedPages, activePages, concurrency);
    dispatchBaselineChunks(activePages, inFlight, concurrency);
    dispatchBorrowedChunks(
      activePages,
      inFlight,
      concurrency,
      () => activePages.length < concurrency,
      () => borrowCursor,
      (value) => {
        borrowCursor = value;
      },
    );

    if (inFlight.size === 0) {
      break;
    }

    await Promise.race(inFlight);
  }
}

function pruneCompletedPages(activePages: ActiveCoordinatorPage[]): void {
  for (let index = activePages.length - 1; index >= 0; index -= 1) {
    const activePage = activePages[index];
    if (!activePage) {
      continue;
    }

    if (activePage.runningCount === 0 && !activePage.page.hasPendingChunks()) {
      activePages.splice(index, 1);
    }
  }
}

function activatePages(
  queuedPages: CoordinatorPage[],
  activePages: ActiveCoordinatorPage[],
  concurrency: number,
): void {
  while (activePages.length < concurrency) {
    const page = queuedPages.shift();
    if (!page) {
      return;
    }

    activePages.push({
      page,
      runningCount: 0,
    });
  }
}

function dispatchBaselineChunks(
  activePages: ActiveCoordinatorPage[],
  inFlight: Set<Promise<void>>,
  concurrency: number,
): void {
  for (const activePage of activePages) {
    if (inFlight.size >= concurrency) {
      return;
    }

    if (activePage.runningCount > 0 || !activePage.page.hasPendingChunks()) {
      continue;
    }

    startChunk(activePage, inFlight);
  }
}

function dispatchBorrowedChunks(
  activePages: ActiveCoordinatorPage[],
  inFlight: Set<Promise<void>>,
  concurrency: number,
  canBorrow: () => boolean,
  getBorrowCursor: () => number,
  setBorrowCursor: (value: number) => void,
): void {
  if (!canBorrow() || activePages.length === 0) {
    return;
  }

  let cursor = getBorrowCursor();

  while (canBorrow() && inFlight.size < concurrency) {
    let madeProgress = false;
    const cycleStartCursor = cursor;

    for (let offset = 0; offset < activePages.length; offset += 1) {
      if (inFlight.size >= concurrency) {
        break;
      }

      const index = (cycleStartCursor + offset) % activePages.length;
      const activePage = activePages[index];
      if (!activePage?.page.hasPendingChunks()) {
        continue;
      }

      startChunk(activePage, inFlight);
      cursor = (index + 1) % activePages.length;
      madeProgress = true;
    }

    if (!madeProgress) {
      break;
    }
  }

  setBorrowCursor(cursor);
}

function startChunk(
  activePage: ActiveCoordinatorPage,
  inFlight: Set<Promise<void>>,
): void {
  activePage.runningCount += 1;

  const chunkPromise = activePage.page.startNextChunk().finally(() => {
    activePage.runningCount = Math.max(0, activePage.runningCount - 1);
    activePage.page.onChunkSettled();
    inFlight.delete(chunkPromise);
  });

  inFlight.add(chunkPromise);
}
