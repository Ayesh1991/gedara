// "Add music" (Phase 7h): drop songs anywhere on the sheet (PC) or choose them (phone: Files,
// Downloads; Android also has Share → Gedara). Each file shows a ring while it uploads and then
// where it is: on its way to the speaker, already on the speaker, or why it can't be added. The
// queue keeps going if the sheet is closed. Also explains the PC's "Gedara Music" folder.
import { Check, CircleAlert, Clock, FolderOpen, Music2, Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Sheet } from '@/components/ui/sheet';
import { addFiles, clearFinished, useUploads, type UploadItem } from '@/lib/media/upload';
import { cn } from '@/lib/utils';

export const AUDIO_ACCEPT = 'audio/*,.mp3,.m4a,.aac,.flac,.ogg,.opus,.wav';

function Ring({ value }: { value: number }) {
  const r = 15;
  const c = 2 * Math.PI * r;
  return (
    <svg viewBox="0 0 36 36" className="h-9 w-9 -rotate-90" aria-hidden>
      <circle cx="18" cy="18" r={r} fill="none" stroke="rgba(255,255,255,0.1)" strokeWidth="3" />
      <circle
        cx="18"
        cy="18"
        r={r}
        fill="none"
        stroke="var(--accent-b)"
        strokeWidth="3"
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - Math.max(0.02, value))}
        className="transition-[stroke-dashoffset] duration-300"
      />
    </svg>
  );
}

function Row({ item }: { item: UploadItem }) {
  const { t } = useTranslation();
  const icon = {
    checking: <Ring value={0.05} />,
    queued: <Clock className="h-5 w-5 text-muted" />,
    uploading: <Ring value={item.progress} />,
    waitingRoom: <Clock className="h-5 w-5 text-caution" />,
    sent: <Check className="h-5 w-5 text-teal" />,
    duplicate: <Check className="h-5 w-5 text-muted" />,
    unsupported: <CircleAlert className="h-5 w-5 text-red" />,
    tooLarge: <CircleAlert className="h-5 w-5 text-red" />,
    failed: <CircleAlert className="h-5 w-5 text-red" />,
  }[item.status];
  return (
    <li className="flex items-center gap-3 py-2">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center" aria-hidden>
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[14.5px]">{item.title ?? item.name}</span>
        <span className={cn('block truncate text-[12.5px]', item.status === 'failed' || item.status === 'unsupported' || item.status === 'tooLarge' ? 'text-red' : 'text-muted')}>
          {item.status === 'uploading'
            ? t('music.add.uploading', { pct: Math.round(item.progress * 100) })
            : t(`music.add.status.${item.status}`)}
        </span>
      </span>
    </li>
  );
}

export function AddMusicSheet({ open, onClose, deviceId, householdId, speakerName }: {
  open: boolean;
  onClose: () => void;
  deviceId: string;
  householdId: string;
  speakerName: string;
}) {
  const { t } = useTranslation();
  const uploads = useUploads();
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const busy = uploads.some((u) => u.status === 'uploading' || u.status === 'checking' || u.status === 'waitingRoom');
  const finished = uploads.filter((u) => !['uploading', 'checking', 'waitingRoom', 'queued'].includes(u.status)).length;

  return (
    <Sheet open={open} onClose={onClose} title={t('music.add.title')}>
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files, deviceId, householdId);
        }}
        className={cn(
          'relative flex flex-col items-center gap-4 overflow-hidden rounded-3xl border border-dashed px-5 py-8 text-center transition-colors',
          over ? 'border-accent-b bg-[color-mix(in_srgb,var(--accent-b)_10%,transparent)]' : 'border-line-2 bg-white/[0.02]',
        )}
      >
        <div aria-hidden className="absolute -top-16 left-1/2 h-40 w-40 -translate-x-1/2 rounded-full opacity-35 blur-3xl" style={{ background: 'var(--glow)' }} />
        <div className="brand-gradient relative flex h-14 w-14 items-center justify-center rounded-2xl text-[#05070F]">
          <Music2 className="h-7 w-7" aria-hidden />
        </div>
        <div className="relative">
          <p className="font-display text-[17px] font-semibold">{t('music.add.drop', { name: speakerName })}</p>
          <p className="mt-1 text-[13px] text-muted">{t('music.add.formats')}</p>
        </div>
        <input
          ref={input}
          type="file"
          multiple
          accept={AUDIO_ACCEPT}
          className="hidden"
          data-testid="music-file-input"
          onChange={(e) => {
            if (e.target.files?.length) addFiles(e.target.files, deviceId, householdId);
            e.target.value = '';
          }}
        />
        <Button variant="accent" className="relative" onClick={() => input.current?.click()}>
          <Upload className="h-4 w-4" aria-hidden />
          {t('music.add.choose')}
        </Button>
      </div>

      {uploads.length > 0 && (
        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between">
            <h3 className="font-display text-[15px] font-semibold">{busy ? t('music.add.inProgress') : t('music.add.done')}</h3>
            {finished > 0 && (
              <button type="button" onClick={clearFinished} className="text-[13px] text-muted hover:text-text">
                {t('music.add.clear')}
              </button>
            )}
          </div>
          <ul className="max-h-[38dvh] divide-y divide-line overflow-y-auto" data-testid="music-uploads">
            {uploads.map((u) => (
              <Row key={u.key} item={u} />
            ))}
          </ul>
        </div>
      )}

      <div className="flex gap-3 rounded-2xl border border-line bg-white/[0.02] p-4">
        <FolderOpen className="mt-0.5 h-5 w-5 shrink-0 text-accent-b" aria-hidden />
        <p className="text-[13.5px] leading-relaxed text-[#a5b0d0]">{t('music.add.pcFolder')}</p>
      </div>
    </Sheet>
  );
}
