import { expect, test } from '@playwright/test';
import { SpeakerSim } from '../../devices/media-player/tools/sim';
import { STORAGE_STATE, stagingAdmin } from './staging-guard';

// Phase 7h done-when, with the software speaker (devices/media-player/tools/sim.ts) speaking the real
// protocol to the real media-agent function: pair a speaker with its 8-digit code in Settings ›
// Devices, add a song in Music (it reaches the speaker, checked by sha256), tap it → the speaker
// gets "play" within 2 s, pause, a sleep timer, "the speaker didn't answer" when it stays silent,
// and deleting the song removes it from the speaker. Everything is named "E2E-7H …" and removed
// afterwards (staging only). One project only: a household may have at most 2 speakers.
test.use({ storageState: STORAGE_STATE });

const PREFIX = 'E2E-7H';
const ingestUrl = () => `${process.env.VITE_SUPABASE_URL!.replace(/\/+$/, '')}/functions/v1/media-agent`;

/** A tiny real MP3: an ID3v2.4 tag (title, artist) and 40 silent MPEG-1 Layer III frames. */
function tinyMp3(title: string, artist: string): Buffer {
  const enc = (s: string) => [3, ...Buffer.from(s, 'utf8')];
  const frame = (id: string, body: number[]) => {
    const n = body.length;
    return [...Buffer.from(id), (n >> 21) & 127, (n >> 14) & 127, (n >> 7) & 127, n & 127, 0, 0, ...body];
  };
  const frames = [...frame('TIT2', enc(title)), ...frame('TPE1', enc(artist))];
  const n = frames.length;
  const tag = [...Buffer.from('ID3'), 4, 0, 0, (n >> 21) & 127, (n >> 14) & 127, (n >> 7) & 127, n & 127, ...frames];
  const mpeg = Buffer.alloc(417 * 40);
  for (let i = 0; i < 40; i++) mpeg.set([0xff, 0xfb, 0x90, 0x64], i * 417);
  return Buffer.concat([Buffer.from(tag), mpeg]);
}

async function cleanup() {
  const admin = stagingAdmin();
  const { data: devices } = await admin.from('device').select('id').eq('kind', 'media').like('name', `${PREFIX}%`);
  const ids = (devices ?? []).map((d) => d.id as string);
  if (!ids.length) return;
  const { data: tracks } = await admin.from('media_track').select('inbox_path').in('device_id', ids);
  const paths = (tracks ?? []).map((t) => t.inbox_path as string | null).filter((p): p is string => !!p);
  if (paths.length) await admin.storage.from('media-inbox').remove(paths);
  await admin.from('device').delete().in('id', ids); // songs, player, commands, schedules go with it
}

test.beforeAll(cleanup);
test.afterAll(cleanup);

test('pair a speaker, add a song, play it within 2 s, pause, sleep, no answer, delete', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'ipad-1024', 'one speaker at a time (a household may have at most 2)');
  test.setTimeout(180_000);
  const sim = new SpeakerSim(ingestUrl());
  const title = `${PREFIX} Rain`;

  // Pairing: the code the installer would show.
  const code = await sim.pairStart();
  await page.goto('/settings/devices');
  await expect(page.getByRole('heading', { name: 'Music speakers', level: 2 })).toBeVisible();
  await page.getByRole('button', { name: 'Add speaker' }).click();
  const sheet = page.getByRole('dialog', { name: 'Add a music speaker' });
  await sheet.getByTestId('pair-code').fill(code);
  await expect(sheet.getByTestId('pair-code')).toHaveValue(`${code.slice(0, 4)} ${code.slice(4)}`);
  await sheet.getByLabel('Name', { exact: true }).fill(`${PREFIX} Speaker`);
  await sheet.getByRole('button', { name: 'Pair', exact: true }).click();
  await expect(page.getByTestId('speaker-row').filter({ hasText: `${PREFIX} Speaker` })).toBeVisible();
  await expect.poll(() => sim.pairPoll()).toBe('paired');
  sim.start();

  try {
    // Add a song.
    await page.goto('/music');
    await expect(page.getByRole('heading', { name: 'Music', level: 1 })).toBeVisible();
    // The household may have a real speaker too: everything here goes to the test speaker only.
    const chooser = page.getByRole('combobox', { name: 'Speaker' });
    if (await chooser.count()) await chooser.selectOption({ label: `${PREFIX} Speaker` });
    await page.getByRole('button', { name: 'Add music' }).first().click();
    await page.getByTestId('music-file-input').setInputFiles({ name: 'rain.mp3', mimeType: 'audio/mpeg', buffer: tinyMp3(title, 'E2E Nature') });
    await expect(page.getByTestId('music-uploads')).toContainText(title);
    await expect(page.getByTestId('music-uploads')).toContainText('On its way to the speaker', { timeout: 30_000 });
    await expect.poll(() => sim.files.size, { timeout: 60_000 }).toBe(1);
    await page.getByRole('button', { name: 'Close' }).click();

    // The song is on the speaker: tap it.
    const song = page.getByRole('button', { name: `Play ${title}` });
    await expect(song).toBeEnabled({ timeout: 30_000 });
    await page.waitForTimeout(1500); // the speaker's long-poll is open again
    const started = Date.now();
    await song.click();
    await expect.poll(() => sim.received.find((c) => c.command === 'play')?.at ?? 0, { timeout: 5000 }).toBeGreaterThan(0);
    const latency = sim.received.find((c) => c.command === 'play')!.at - started;
    testInfo.annotations.push({ type: 'latency', description: `${latency} ms from the tap to the speaker` });
    console.log(`[${testInfo.project.name}] tap → speaker: ${latency} ms`);
    expect(latency).toBeLessThan(2000);
    await expect(page.getByRole('heading', { name: title, level: 2 })).toBeVisible();

    // How it looks while playing: phone, iPad, desktop (attached to the report; rule 10).
    for (const [label, size] of [['phone-375', { width: 375, height: 812 }], ['ipad', { width: 1024, height: 1366 }], ['desktop', { width: 1440, height: 900 }]] as const) {
      await page.setViewportSize(size);
      await page.waitForTimeout(600);
      await page.screenshot({ path: testInfo.outputPath(`music-${label}.png`), fullPage: label === 'phone-375' });
    }
    await page.goto('/');
    await page.setViewportSize({ width: 375, height: 812 });
    await expect(page.getByTestId('mini-player')).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('mini-player-375.png') });
    await page.setViewportSize({ width: 1024, height: 1366 });
    await page.goto('/music');

    // Pause, then a sleep timer.
    await page.getByRole('button', { name: 'Pause', exact: true }).first().click();
    await expect.poll(() => sim.player.state).toBe('paused');
    await page.getByRole('button', { name: '30 min', exact: true }).click();
    await expect.poll(() => sim.player.sleepUntil ?? 0).toBeGreaterThan(Date.now() + 29 * 60_000);
    await expect(page.getByText('Fades out in 30 minutes')).toBeVisible();

    // A speaker that doesn't answer: the screen goes back and says so.
    sim.deaf = true;
    await page.getByRole('button', { name: 'Play', exact: true }).first().click();
    await expect(page.getByText("The speaker didn't answer")).toBeVisible({ timeout: 12_000 });
    sim.deaf = false;

    // Phase 7i: a phone takes the speaker over AirPlay; Gedara says so, and Play asks before taking over.
    sim.external = { source: 'airplay', name: 'E2E iPhone' };
    await sim.sync(false);
    await expect(page.getByTestId('source-banner')).toContainText('Playing from AirPlay');
    await expect(page.getByTestId('source-banner')).toContainText('E2E iPhone');
    await page.getByRole('button', { name: 'Play', exact: true }).first().click();
    await page.getByRole('button', { name: 'Play here' }).click();
    await expect.poll(() => sim.external).toBeNull();
    await expect(page.getByTestId('source-banner')).toHaveCount(0, { timeout: 15_000 });

    // The Bluetooth pairing window opens for 2 minutes from the speaker's page.
    await page.goto(`/settings/speaker/${sim.deviceId}`);
    await page.getByRole('button', { name: 'Let a phone or PC pair (2 min)' }).click();
    await expect(page.getByTestId('bt-pairing')).toContainText('Pairing open');
    await expect.poll(() => sim.btPairingUntil).toBeGreaterThan(Date.now() + 100_000);
    await page.goto('/music');

    // Delete it from the speaker.
    await page.getByRole('button', { name: `More for ${title}` }).click();
    await page.getByRole('button', { name: 'Delete from the speaker' }).click();
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect.poll(() => sim.files.size, { timeout: 30_000 }).toBe(0);
    await expect(page.getByRole('button', { name: `Play ${title}` })).toHaveCount(0, { timeout: 15_000 });
  } finally {
    sim.stop();
  }
});
