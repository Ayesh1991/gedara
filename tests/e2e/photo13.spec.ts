import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { STORAGE_STATE, stagingAdmin } from './staging-guard';

// v0.13.0: photo by scan (QR on the PC's photo space → the phone opens the camera → one tap saves →
// the PC shows it without a reload) and "Used" for things (mark, Undo, history, Bring back).
// Everything carries "E2E-13 <p|i>" and is removed afterwards with the staging service-role client.
test.use({ storageState: STORAGE_STATE });

const token = (project: string) => `E2E-13 ${project.startsWith('phone') ? 'p' : 'i'}`;
const BUCKET = 'household-files';

test.afterAll(async ({}, testInfo) => {
  const admin = stagingAdmin();
  const { data: assets, error } = await admin.from('asset').select('id').like('name', `${token(testInfo.project.name)}%`);
  if (error) throw error;
  const ids = assets.map((a) => a.id);
  if (!ids.length) return;
  const { data: files } = await admin.from('attachment').select('storage_path, thumb_path').in('entity_id', ids);
  const paths = (files ?? []).flatMap((f) => [f.storage_path, f.thumb_path]).filter((p): p is string => Boolean(p));
  if (paths.length) await admin.storage.from(BUCKET).remove(paths);
  await admin.from('attachment').delete().in('entity_id', ids);
  const r = await admin.from('asset').delete().in('id', ids);
  if (r.error) throw r.error;
});

/** The e2e user's own client (saved session): triggers and RLS apply as in real use. */
function userClient() {
  const state = JSON.parse(readFileSync(STORAGE_STATE, 'utf8')) as {
    origins: Array<{ localStorage: Array<{ name: string; value: string }> }>;
  };
  const item = state.origins.flatMap((o) => o.localStorage).find((i) => /^sb-.*-auth-token$/.test(i.name));
  const accessToken = (JSON.parse(item!.value) as { access_token: string }).access_token;
  return createClient(process.env.VITE_SUPABASE_URL!, process.env.VITE_SUPABASE_ANON_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

async function newThing(name: string): Promise<{ id: string; code: string }> {
  stagingAdmin(); // refuses unless this is staging
  const db = userClient();
  const { data: member, error: mErr } = await db.from('household_member').select('household_id').limit(1).single();
  if (mErr) throw mErr;
  const { data, error } = await db
    .from('asset')
    .insert({ household_id: member.household_id, name, purchase_price: 450, purchased_on: '2026-11-01' })
    .select('id, code')
    .single();
  if (error) throw error;
  return data;
}

/** A fake rear camera: a canvas stream with a drawn "photo" (Edge's real camera isn't there in CI). */
async function fakeCamera(page: Page) {
  await page.addInitScript(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 1280;
    canvas.height = 960;
    const ctx = canvas.getContext('2d')!;
    let n = 0;
    setInterval(() => {
      n += 1;
      ctx.fillStyle = '#2fc6a0';
      ctx.fillRect(0, 0, 1280, 960);
      ctx.fillStyle = '#f5b83d';
      ctx.fillRect(200 + (n % 50), 200, 600, 400);
    }, 50);
    const md = navigator.mediaDevices ?? ({} as MediaDevices);
    Object.defineProperty(navigator, 'mediaDevices', { value: md, configurable: true });
    md.getUserMedia = async () => canvas.captureStream(20);
  });
}

async function noSidewaysScroll(page: Page, label: string) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, label).toBeLessThanOrEqual(0);
}

test('photo by scan: QR on the PC, camera on the phone, the PC updates by itself', async ({ page, context }, testInfo) => {
  const tag = token(testInfo.project.name);
  const thing = await newThing(`${tag} Hinges`);

  // The "PC": a wide window with the thing open.
  const pc = await context.newPage();
  await pc.setViewportSize({ width: 1280, height: 860 });
  await pc.goto(`/things/${thing.id}`);
  const qr = pc.getByTestId('photo-qr');
  await expect(qr).toBeVisible();
  const url = await qr.getAttribute('data-url');
  expect(url).toBe(`${new URL(pc.url()).origin}/s/${thing.code}?photo=1`);
  await expect(pc.locator('img[src*=".thumb.webp"]')).toHaveCount(0);
  // Tap → a bigger QR to scan from further away.
  await qr.click();
  await expect(pc.getByRole('dialog', { name: 'Take the photo with your phone' })).toBeVisible();
  await pc.keyboard.press('Escape');

  // The "phone": Gedara's Scan screen reads the QR (typed here, the same handler as the camera).
  await fakeCamera(page);
  await page.goto('/scan');
  if (testInfo.project.name.startsWith('phone')) {
    // Phones keep the pencil; the QR is for the bigger screen.
    await page.goto(`/things/${thing.id}`);
    await expect(page.getByTestId('photo-edit')).toBeVisible();
    await expect(page.getByTestId('photo-qr')).toBeHidden();
    await page.goto('/scan');
  }
  await page.locator('#scan-code').fill(url!);
  await page.getByRole('button', { name: 'Find' }).click();
  await expect(page).toHaveURL(new RegExp(`/things/${thing.id}\\?photo=1$`));
  const sheet = page.getByTestId('photo-scan-sheet');
  await expect(sheet).toBeVisible();
  await noSidewaysScroll(page, 'camera sheet fits');
  const shutter = page.getByTestId('photo-scan-shutter');
  await expect(shutter).toBeEnabled(); // started with no tap
  await shutter.click();
  await expect(page.getByTestId('photo-scan-saved')).toBeVisible({ timeout: 30_000 });

  // The PC shows it without a reload (Realtime on attachment).
  await expect(pc.locator('img[src*=".thumb.webp"]')).toHaveCount(1, { timeout: 20_000 });

  // Retake replaces it (still one primary photo), Done clears ?photo.
  await page.getByRole('button', { name: 'Retake' }).click();
  await expect(shutter).toBeEnabled();
  await shutter.click();
  await expect(page.getByTestId('photo-scan-saved')).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page).toHaveURL(new RegExp(`/things/${thing.id}$`));
  const { count } = await stagingAdmin().from('attachment').select('id', { count: 'exact', head: true }).eq('entity_id', thing.id);
  expect(count).toBe(1);

  // The /s/ deep link (a phone's own camera app) also opens the camera.
  await page.goto(`/s/${thing.code}?photo=1`);
  await expect(page).toHaveURL(new RegExp(`/things/${thing.id}\\?photo=1$`));
  await expect(page.getByText('This replaces the current photo.')).toBeVisible();
  await pc.close();
});

test('Used: leaves the list with a note, Undo, history, Bring back', async ({ page }, testInfo) => {
  const tag = token(testInfo.project.name);
  const thing = await newThing(`${tag} Wood screws`);
  await page.goto(`/things/${thing.id}`);
  await expect(page.getByTestId('asset-name')).toContainText('Wood screws');

  await page.getByRole('button', { name: 'Used', exact: true }).click();
  const form = page.getByTestId('used-form');
  await form.getByLabel('What did it go into? (optional)').fill('Book rack, living room');
  await noSidewaysScroll(page, 'used sheet fits');
  await form.getByRole('button', { name: 'Mark as used' }).click();
  await expect(page.getByTestId('used-info')).toContainText('went into Book rack, living room');
  await expect(page.getByText('Used in Book rack, living room')).toBeVisible(); // history

  // Undo from the toast puts it back.
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByTestId('used-info')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Used', exact: true })).toBeVisible();

  // Mark again: gone from the active list, listed under the gone filter.
  await page.getByRole('button', { name: 'Used', exact: true }).click();
  await page.getByTestId('used-form').getByRole('button', { name: 'Mark as used' }).click();
  await expect(page.getByTestId('used-info')).toBeVisible();
  await page.goto(`/things?q=${encodeURIComponent('Wood screws')}`);
  await expect(page.getByText(`${tag} Wood screws`)).toBeHidden();
  await page.goto(`/things?filter=gone&q=${encodeURIComponent('Wood screws')}`);
  await expect(page.getByText(`${tag} Wood screws`)).toBeVisible();

  // Bring back.
  await page.goto(`/things/${thing.id}`);
  await page.getByRole('button', { name: 'Not used — bring back' }).click();
  await expect(page.getByTestId('used-info')).toBeHidden();
  // History: once from the toast's Undo, once from Bring back.
  await expect(page.getByText('Brought back (not used after all)')).toHaveCount(2);
  const { data } = await stagingAdmin().from('asset').select('status, gone_on, gone_note').eq('id', thing.id).single();
  expect(data).toEqual({ status: 'in_use', gone_on: null, gone_note: null });
});
