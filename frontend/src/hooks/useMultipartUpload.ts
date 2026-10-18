'use client';

import 'reflect-metadata';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { configureUploadContainer, MultipartUploadService } from '@/lib/upload';
import type { UploadOptions, UploadProgress, UploadSessionView, UploadTask } from '@/lib/upload';

const IDLE: UploadProgress = {
  state: 'idle',
  totalBytes: 0,
  uploadedBytes: 0,
  percent: 0,
  partsDone: 0,
  partCount: 0,
  activeParts: 0,
  retryingParts: [],
  speedBytesPerSec: 0,
  etaSeconds: null,
  error: null,
};

export function useMultipartUpload(options: Omit<UploadOptions, 'onProgress'> = {}) {
  const service = useMemo(() => configureUploadContainer().resolve(MultipartUploadService), []);
  const taskRef = useRef<UploadTask | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);
  const [progress, setProgress] = useState<UploadProgress>(IDLE);

  const start = useCallback(
    async (file: File): Promise<UploadSessionView | null> => {
      unsubscribeRef.current?.();
      const task = service.createTask(file, options);
      taskRef.current = task;
      unsubscribeRef.current = task.subscribe(setProgress);
      try {
        return await task.start();
      } catch {
        return null; // failure/cancel is reflected in `progress` (state + error)
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [service, options.concurrency, options.maxRounds],
  );

  const pause = useCallback(() => taskRef.current?.pause(), []);
  const resume = useCallback(() => void taskRef.current?.resume().catch(() => undefined), []);
  const cancel = useCallback(() => void taskRef.current?.cancel(), []);

  // Warn before closing the tab mid-upload.
  useEffect(() => {
    const active = ['preparing', 'uploading', 'completing'].includes(progress.state);
    if (!active) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [progress.state]);

  useEffect(() => () => unsubscribeRef.current?.(), []);

  return { progress, start, pause, resume, cancel };
}
