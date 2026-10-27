import { processBytes } from '../pipeline/index';
import type { Dataset, ProgressUpdate } from '../types';

interface WorkerRequest {
  id: number;
  name: string;
  mime: string;
  buffer: ArrayBuffer;
}

type WorkerResponse =
  | { type: 'progress'; id: number; progress: ProgressUpdate }
  | { type: 'result'; id: number; datasets: Dataset[] }
  | { type: 'error'; id: number; message: string };

const ctx = self as unknown as {
  postMessage(message: WorkerResponse): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<WorkerRequest>) => void): void;
};

ctx.addEventListener('message', async (event) => {
  const { id, name, mime, buffer } = event.data;
  try {
    const datasets = await processBytes(name, mime, new Uint8Array(buffer), {
      onProgress: (progress) => ctx.postMessage({ type: 'progress', id, progress }),
    });
    ctx.postMessage({ type: 'result', id, datasets });
  } catch (error) {
    ctx.postMessage({
      type: 'error',
      id,
      message: error instanceof Error ? error.message : String(error),
    });
  }
});
