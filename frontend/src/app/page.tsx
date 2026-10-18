import { UploadWidget } from '@/components/UploadWidget';

export default function Page() {
  return (
    <main className="wrap">
      <h1>Resumable large-file upload</h1>
      <p>Multipart, direct-to-S3, per-chunk retry, pause/resume.</p>
      <UploadWidget />
    </main>
  );
}
