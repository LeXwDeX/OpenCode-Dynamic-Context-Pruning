export async function runWithConcurrency<T>(
    items: T[],
    concurrency: number,
    task: (item: T) => Promise<void>,
): Promise<void> {
    let nextIndex = 0
    const workerCount = Math.min(items.length, Math.max(1, Math.floor(concurrency)))
    const workers = Array.from({ length: workerCount }, async () => {
        for (;;) {
            const index = nextIndex++
            if (index >= items.length) return
            await task(items[index])
        }
    })
    await Promise.all(workers)
}
