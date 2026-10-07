// Firmware updates for a scale (Phase 6b, Didula: upload on the website, install on tap). The owner
// uploads firmware.bin from VS Code's build folder; the browser checks it is kitchen-scale firmware
// for an ESP32-S3 and reads its version. Install queues an `ota` command; the scale downloads it,
// checks its sha256, switches, and rolls back by itself if the new version can't reach Gedara.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { compareVersions } from '@/lib/scale/espImage';
import {
  FirmwareFileError,
  firmwareQuery,
  scaleErrorKey,
  scaleKey,
  sendCommand,
  uploadFirmware,
  type ScaleDevice,
} from '@/lib/scale/queries';

export function FirmwarePanel({ householdId, device, isOwner, locale }: { householdId: string; device: ScaleDevice; isOwner: boolean; locale: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const firmware = useQuery(firmwareQuery(householdId));
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const day = new Intl.DateTimeFormat(locale, { dateStyle: 'medium' });

  async function upload(file: File) {
    setBusy(true);
    try {
      const r = await uploadFirmware(householdId, file);
      toast.success(t('scale.firmware.uploaded', { version: r.version }));
      await qc.invalidateQueries({ queryKey: scaleKey(householdId, 'firmware') });
    } catch (e) {
      toast.error(e instanceof FirmwareFileError ? t(`scale.firmware.problems.${e.problem}`) : t(`scale.errors.${scaleErrorKey(e)}`));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  }

  async function install(id: string, version: string) {
    if (!window.confirm(t('scale.firmware.installConfirm', { version, name: device.name }))) return;
    try {
      await sendCommand(device.id, 'ota', { firmware_id: id });
      toast.success(t('scale.firmware.installing', { version }));
    } catch (e) {
      toast.error(t(`scale.errors.${scaleErrorKey(e)}`));
    }
  }

  const current = device.fw_version;
  const ota = device.status?.ota;

  return (
    <Card className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <h2 className="flex-1 font-display text-[19px] font-semibold">{t('scale.firmware.title')}</h2>
        <span className="tabular text-[13px] text-muted">{t('scale.firmware.current', { version: current ?? '—' })}</span>
      </div>
      {ota && <p className="text-[13px] text-info">{t('scale.firmware.otaState', { state: ota })}</p>}
      {(firmware.data ?? []).length === 0 ? (
        <p className="text-[14px] text-muted">{t('scale.firmware.none')}</p>
      ) : (
        <ul className="divide-y divide-line">
          {firmware.data!.map((f) => {
            const newer = !current || compareVersions(f.version, current) > 0;
            return (
              <li key={f.id} className="flex items-center gap-3 py-2">
                <span className="tabular w-20 font-medium">{f.version}</span>
                <span className="min-w-0 flex-1 truncate text-[12.5px] text-muted">
                  {day.format(new Date(f.created_at))} · {(f.size / 1024 / 1024).toFixed(2)} MB
                </span>
                {isOwner && newer && (
                  <Button size="sm" variant="accent" onClick={() => void install(f.id, f.version)}>
                    <Download className="h-4 w-4" aria-hidden />
                    {t('scale.firmware.install')}
                  </Button>
                )}
                {f.version === current && <span className="text-[12.5px] text-teal">{t('scale.firmware.installed')}</span>}
              </li>
            );
          })}
        </ul>
      )}
      {isOwner && (
        <>
          <input
            ref={input}
            type="file"
            accept=".bin,application/octet-stream"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void upload(f);
            }}
          />
          <Button variant="secondary" disabled={busy} onClick={() => input.current?.click()}>
            <Upload className="h-4 w-4" aria-hidden />
            {t('scale.firmware.upload')}
          </Button>
          <p className="text-[12.5px] text-faint">{t('scale.firmware.uploadHint')}</p>
        </>
      )}
    </Card>
  );
}
