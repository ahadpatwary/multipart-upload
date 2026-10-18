'use client';

import { useRef } from 'react';
import { useMultipartUpload } from '@/hooks/useMultipartUpload';

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

function formatEta(s: number | null): string {
  if (s === null) return '—';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}

export function UploadWidget() {
  const inputRef = useRef<HTMLInputElement>(null);
  const { progress: p, start, pause, resume, cancel } = useMultipartUpload({ concurrency: 4 });

  const busy = ['preparing', 'uploading', 'completing'].includes(p.state);
  const finished = ['completed', 'cancelled'].includes(p.state);

  return (
    <div className="card">
      <input
        ref={inputRef}
        type="file"
        accept="video/*,audio/*"
        disabled={busy}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void start(file);
          e.target.value = '';
        }}
      />

      {p.state !== 'idle' && (
        <>
          <div className="bar" role="progressbar" aria-valuenow={p.percent} aria-valuemin={0} aria-valuemax={100}>
            <div className="fill" style={{ width: `${p.percent}%` }} />
          </div>

          <p className="meta">
            <strong>{p.state}</strong> · {p.percent}% · {formatBytes(p.uploadedBytes)} / {formatBytes(p.totalBytes)}
            {p.state === 'uploading' && (
              <>
                {' '}
                · {formatBytes(p.speedBytesPerSec)}/s · ETA {formatEta(p.etaSeconds)} · parts {p.partsDone}/
                {p.partCount} (active {p.activeParts})
              </>
            )}
          </p>

          {p.retryingParts.length > 0 && p.state === 'uploading' && (
            <p className="warn">Retrying only part(s): {p.retryingParts.join(', ')}</p>
          )}

          {p.error && (
            <p className="error">
              {p.error.message} <code>{p.error.code}</code>
            </p>
          )}

          <div className="actions">
            {p.state === 'uploading' && <button onClick={pause}>Pause</button>}
            {(p.state === 'paused' || p.state === 'failed') && (
              <button onClick={resume}>{p.state === 'failed' ? 'Retry' : 'Resume'}</button>
            )}
            {!finished && <button onClick={cancel}>Cancel</button>}
          </div>
        </>
      )}
    </div>
  );
}
