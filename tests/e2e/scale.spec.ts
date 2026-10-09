import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { ScaleSim } from '../../devices/kitchen-scale/tools/sim';
import { STORAGE_STATE, stagingAdmin } from './staging-guard';

// Phase 6b done-when, with the software scale (devices/kitchen-scale/tools/sim.ts) speaking the real
// protocol to the real scale-ingest function: "Lift the sugar jar, use 2 spoons, put it back →
// 'Sugar −24 g' appears on the iPad within 2 s". Also: the scale is added in Settings › Devices
// (token shown once), an exact replay moves nothing, Undo puts the 24 g back, a pop-up appears on
// another screen, and a heavier jar with nothing in the pantry asks and is settled by Count
// correction. Everything is named "E2E-6B <p|i> …" and removed afterwards (staging only).
test.use({ storageState: STORAGE_STATE });

const tag = (project: string) => `E2E-6B ${project.startsWith('phone') ? 'p' : 'i'}`;

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

const ingestUrl = () => `${process.env.VITE_SUPABASE_URL!.replace(/\/+$/, '')}/functions/v1/scale-ingest`;
const randomUid = () => `04${Array.from({ length: 6 }, () => Math.floor(Math.random() * 256).toString(16).padStart(2, '0')).join('').toUpperCase()}`;

test.afterAll(async ({}, testInfo) => {
  const admin = stagingAdmin();
  const like = `${tag(testInfo.project.name)}%`;
  const { data: devices } = await admin.from('device').select('id').like('name', like);
  const deviceIds = (devices ?? []).map((d) => d.id as string);
  if (deviceIds.length) {
    await admin.from('scale_reading').delete().in('device_id', deviceIds);
    await admin.from('device').delete().in('id', deviceIds);
  }
  const { data: products } = await admin.from('product').select('id').like('name', like);
  const ids = (products ?? []).map((p) => p.id as string);
  const { data: places } = await admin.from('location').select('id').like('name', like);
  const placeIds = (places ?? []).map((p) => p.id as string);
  if (placeIds.length) await admin.from('scale_reading').delete().in('location_id', placeIds);
  if (ids.length) {
    await admin.from('stock_movement').delete().in('product_id', ids);
    await admin.from('stock_lot').delete().in('product_id', ids);
    await admin.from('location').update({ holds_product_id: null }).in('holds_product_id', ids);
    await admin.from('product').delete().in('id', ids);
  }
  if (placeIds.length) await admin.from('location').delete().in('id', placeIds);
});

interface Jar {
  household: string;
  productId: string;
  jarId: string;
  uid: string;
}

/** A product counted in grams, a container holding it (empty weight 400 g) with `grams` inside, a tag. */
async function seedJar(name: string, grams: number): Promise<Jar> {
  stagingAdmin(); // refuses unless this is staging
  const db = userClient();
  const household = (await db.from('household_member').select('household_id').limit(1).single()).data!.household_id as string;
  const g = (await db.from('unit').select('id').is('household_id', null).eq('code', 'g').single()).data!.id as string;
  const product = await db.from('product').insert({ household_id: household, name, stock_unit_id: g }).select('id').single();
  if (product.error) throw product.error;
  const jar = await db
    .from('location')
    .insert({ household_id: household, name: `${name} jar`, kind: 'container', holds_product_id: product.data.id, tare_g: 400 })
    .select('id')
    .single();
  if (jar.error) throw jar.error;
  if (grams > 0) {
    const buy = await db.rpc('rpc_purchase', {
      p: { household_id: household, product_id: product.data.id, qty: grams, location_id: jar.data.id, total_cost: grams * 0.3 },
    });
    if (buy.error) throw buy.error;
  }
  const uid = randomUid();
  const link = await db.rpc('rpc_nfc_tag_link', { p_location: jar.data.id, p_uid: uid, p_move: false });
  if (link.error) throw link.error;
  return { household, productId: product.data.id, jarId: jar.data.id, uid };
}

async function jarGrams(jarId: string): Promise<number> {
  const { data } = await userClient().from('stock_lot').select('qty_remaining').eq('location_id', jarId);
  return (data ?? []).reduce((s, l) => s + Number(l.qty_remaining), 0);
}

/** Settings › Devices › Add scale: the token is shown once. */
async function addScale(page: import('@playwright/test').Page, name: string): Promise<ScaleSim> {
  await page.goto('/settings/devices');
  await expect(page.getByRole('heading', { name: 'Kitchen scales', level: 2 })).toBeVisible();
  await page.getByLabel('Scale name').fill(name);
  await page.getByRole('button', { name: 'Add scale' }).click();
  const token = (await page.getByTestId('scale-token').textContent())!.trim();
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  await page.getByRole('button', { name: "I've copied everything" }).click();
  return new ScaleSim({ url: ingestUrl(), token, fw: '0.0.0-e2e' });
}

test('Sugar −24 g reaches the Kitchen-scale page within 2 s; a replay moves nothing; Undo', async ({ page }, testInfo) => {
  const t = tag(testInfo.project.name);
  const jar = await seedJar(`${t} Sugar`, 812);
  const sim = await addScale(page, `${t} Scale`);

  await page.goto('/pantry/scale');
  await expect(page.getByRole('heading', { name: 'Kitchen scale', level: 1 })).toBeVisible();
  // First contact: the live state arrives over Realtime (this page doesn't poll), so the channel is up.
  const warm = await sim.sync({ live: { state: 'empty', gross_g: 0 } });
  expect(warm.ok, JSON.stringify(warm)).toBe(true);
  await expect(page.getByTestId('scale-live').filter({ hasText: `${t} Scale` })).toHaveAttribute('data-state', 'empty');

  // The jar goes back on the scale 24 g lighter (812 → 788 g; gross = 400 g jar + 788 g).
  const started = Date.now();
  const result = await sim.weigh(jar.uid, 400 + 788);
  expect(result?.status).toBe('consumed');
  const card = page.getByTestId('scale-reading').first();
  await expect(card.getByTestId('scale-reading-title')).toHaveText(`${t} Sugar`, { timeout: 2000 });
  await expect(card.getByTestId('scale-reading-delta')).toHaveText('−24 g', { timeout: 2000 });
  const elapsed = Date.now() - started;
  testInfo.annotations.push({ type: 'latency', description: `${elapsed} ms from the scale's POST to the card` });
  console.log(`[${testInfo.project.name}] scale POST → card on screen: ${elapsed} ms`);
  expect(elapsed).toBeLessThan(2000);
  await expect(card.getByTestId('scale-reading-left')).toHaveText('788 g left');
  expect(await jarGrams(jar.jarId)).toBe(788);

  // The scale resends the same reading (lost reply): same answer, nothing taken twice.
  const seq = Number(result!.seq);
  sim.outbox.push({ seq, b: 1, t: sim.up(), type: 'weigh', uid: jar.uid, gross_g: 1188, at: Date.now() });
  const replay = await sim.sync();
  expect(replay.results?.find((r) => r.seq === seq)?.replayed).toBe(true);
  const { count } = await userClient()
    .from('stock_movement')
    .select('id', { count: 'exact', head: true })
    .eq('product_id', jar.productId)
    .eq('reason', 'consume');
  expect(count).toBe(1);
  expect(await jarGrams(jar.jarId)).toBe(788);

  await card.getByRole('button', { name: 'Undo' }).click();
  await expect(card.getByText('Undone')).toBeVisible();
  await expect.poll(() => jarGrams(jar.jarId)).toBe(812);
});

test('a pop-up on another screen; a heavier jar asks and Count correction settles it', async ({ page }, testInfo) => {
  const t = tag(testInfo.project.name);
  const jar = await seedJar(`${t} Rice`, 500);
  const sim = await addScale(page, `${t} Scale 2`);

  await page.goto('/pantry');
  await expect(page.getByRole('heading', { name: 'Pantry', level: 1 })).toBeVisible();
  await page.waitForTimeout(1500); // let the Realtime channel join
  // 300 g poured in from a pack nobody entered: nothing to move from, so it asks.
  const result = await sim.weigh(jar.uid, 400 + 800);
  expect(result?.status).toBe('needs_decision');
  const popup = page.getByTestId('scale-popups').getByTestId('scale-reading');
  await expect(popup).toHaveAttribute('data-status', 'needs_decision');
  await expect(popup.getByTestId('scale-reading-delta')).toHaveText('+300 g');
  await popup.getByRole('button', { name: 'Count correction' }).click();
  await expect(page.getByText('Done — 800 g in the container')).toBeVisible();
  await expect.poll(() => jarGrams(jar.jarId)).toBe(800);

  // The scale's log (its Serial Monitor once the USB port is sealed in) shows on its page, live.
  await page.goto('/settings/devices');
  await page.getByRole('link', { name: new RegExp(`${t} Scale 2`) }).click();
  await expect(page.getByRole('heading', { name: 'Scale log' })).toBeVisible();
  await page.waitForTimeout(1500); // let the Realtime channel join
  const sent = await sim.sync({ log: [{ t: sim.up(), m: `[SCALE] steady: 1000.2 g (after 0.9 s) ${t}` }] });
  expect(sent.ok, JSON.stringify(sent)).toBe(true);
  await expect(page.getByTestId('scale-log')).toContainText(`[SCALE] steady: 1000.2 g (after 0.9 s) ${t}`);
});
