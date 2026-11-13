import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { ScannerSim } from '../../devices/bin-scanner/tools/sim';
import { STORAGE_STATE, stagingAdmin } from './staging-guard';

// Phase 11 done-when, with the software scanner (devices/bin-scanner/tools/sim.ts) speaking the real
// protocol to the real scanner-ingest function: a finished yoghurt cup is scanned at the bin and
// "Yoghurt · 5 left" pops up on another screen within 2 s, with Undo. Also: the scanner is added in
// Settings › Devices (key shown once) and gets the names list, an exact replay moves nothing, a
// barcode Gedara doesn't know waits under "Needs you" and is applied after being linked once, and a
// product with no stock goes on the shopping list. Everything is named "E2E-BIN <p|i> …" and removed
// afterwards (staging only).
test.use({ storageState: STORAGE_STATE });

const tag = (project: string) => `E2E-BIN ${project.startsWith('phone') ? 'p' : 'i'}`;

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

const ingestUrl = () => `${process.env.VITE_SUPABASE_URL!.replace(/\/+$/, '')}/functions/v1/scanner-ingest`;
/** A 13-digit in-store code (prefix 2) nobody else uses. */
const randomBarcode = () => `2${Array.from({ length: 12 }, () => Math.floor(Math.random() * 10)).join('')}`;

// A household may have 3 scanners: each test's scanner goes when the test ends.
async function removeScanners(project: string) {
  const admin = stagingAdmin();
  const { data: devices } = await admin.from('device').select('id').like('name', `${tag(project)}%`);
  const deviceIds = (devices ?? []).map((d) => d.id as string);
  if (deviceIds.length) {
    await admin.from('bin_scan').delete().in('device_id', deviceIds);
    await admin.from('device').delete().in('id', deviceIds);
  }
}

test.afterEach(async ({}, testInfo) => {
  await removeScanners(testInfo.project.name);
});

test.afterAll(async ({}, testInfo) => {
  const admin = stagingAdmin();
  const like = `${tag(testInfo.project.name)}%`;
  await removeScanners(testInfo.project.name);
  const { data: products } = await admin.from('product').select('id').like('name', like);
  const ids = (products ?? []).map((p) => p.id as string);
  if (ids.length) {
    await admin.from('bin_scan').delete().in('product_id', ids);
    await admin.from('shopping_list_item').delete().in('product_id', ids);
    await admin.from('stock_movement').delete().in('product_id', ids);
    await admin.from('stock_lot').delete().in('product_id', ids);
    await admin.from('product').delete().in('id', ids);
  }
});

interface Seeded {
  household: string;
  productId: string;
  barcode: string | null;
}

/** A product counted in pieces with `stock` of it, and (unless `noBarcode`) a barcode meaning one piece. */
async function seedProduct(name: string, stock: number, noBarcode = false): Promise<Seeded> {
  stagingAdmin(); // refuses unless this is staging
  const db = userClient();
  const household = (await db.from('household_member').select('household_id').limit(1).single()).data!.household_id as string;
  const pcs = (await db.from('unit').select('id').is('household_id', null).eq('code', 'pcs').single()).data!.id as string;
  const product = await db.from('product').insert({ household_id: household, name, stock_unit_id: pcs }).select('id').single();
  if (product.error) throw product.error;
  let barcode: string | null = null;
  if (!noBarcode) {
    barcode = randomBarcode();
    const b = await db.from('product_barcode').insert({ household_id: household, product_id: product.data.id, barcode });
    if (b.error) throw b.error;
  }
  if (stock > 0) {
    const buy = await db.rpc('rpc_purchase', { p: { household_id: household, product_id: product.data.id, qty: stock } });
    if (buy.error) throw buy.error;
  }
  return { household, productId: product.data.id, barcode };
}

async function stockOf(productId: string): Promise<number> {
  const { data } = await userClient().from('stock_lot').select('qty_remaining').eq('product_id', productId);
  return (data ?? []).reduce((s, l) => s + Number(l.qty_remaining), 0);
}

/** Settings › Devices › Add scanner: the key is shown once. */
async function addScanner(page: import('@playwright/test').Page, name: string): Promise<ScannerSim> {
  await page.goto('/settings/devices');
  await expect(page.getByRole('heading', { name: 'Bin scanners', level: 2 })).toBeVisible();
  await page.getByLabel('Scanner name').fill(name);
  await page.getByRole('button', { name: 'Add scanner' }).click();
  const token = (await page.getByTestId('scanner-token').textContent())!.trim();
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  await page.getByTestId('scanner-devices').getByRole('button', { name: "I've copied everything" }).click();
  return new ScannerSim({ url: ingestUrl(), token, fw: '0.0.0-e2e' });
}

test('a finished cup scanned at the bin pops up within 2 s; a replay moves nothing; Undo', async ({ page }, testInfo) => {
  const t = tag(testInfo.project.name);
  const yoghurt = await seedProduct(`${t} Yoghurt`, 6);
  const sim = await addScanner(page, `${t} Scanner`);

  // First contact: the scanner reports in and gets its settings and the names list.
  const hello = await sim.sync();
  expect(hello.ok, JSON.stringify(hello)).toBe(true);
  expect(sim.names.get(yoghurt.barcode!)).toBe(`${t} Yoghurt`);
  expect(hello.next_ms).toBeGreaterThanOrEqual(5000); // no polling: a heartbeat, or a few seconds while a command waits

  await page.goto('/pantry');
  await expect(page.getByRole('heading', { name: 'Pantry', level: 1 })).toBeVisible();
  await page.waitForTimeout(1500); // Realtime says "joined" a moment before changes flow

  const started = Date.now();
  const result = await sim.scan(yoghurt.barcode!);
  const answered = Date.now() - started;
  expect(result?.status).toBe('used');
  // Phone and iPad runs share one household and see each other's pop-ups: pick this run's card.
  const popup = page.getByTestId('scanner-popups').getByTestId('scanner-scan').filter({ hasText: `${t} Yoghurt` }).first();
  await expect(popup.getByTestId('scanner-scan-title')).toHaveText(`${t} Yoghurt`, { timeout: 2000 });
  await expect(popup.getByTestId('scanner-scan-left')).toHaveText('5 left', { timeout: 2000 });
  const elapsed = Date.now() - started;
  testInfo.annotations.push({ type: 'latency', description: `${elapsed} ms from the scanner's POST to the pop-up` });
  console.log(`[${testInfo.project.name}] scanner POST answered in ${answered} ms; pop-up on screen after ${elapsed} ms`);
  expect(elapsed).toBeLessThan(2000);
  expect(await stockOf(yoghurt.productId)).toBe(5);

  // The scanner resends the same scan (lost reply): same answer, nothing taken twice.
  const seq = Number(result!.seq);
  sim.outbox.push({ seq, b: 1, t: sim.up(), at: Date.now(), type: 'scan', mode: 'use', code: yoghurt.barcode! });
  const replay = await sim.sync();
  expect(replay.results?.find((r) => r.seq === seq)?.replayed).toBe(true);
  expect(await stockOf(yoghurt.productId)).toBe(5);

  await popup.getByRole('button', { name: 'Undo' }).click();
  await expect.poll(() => stockOf(yoghurt.productId)).toBe(6);

  // Add mode never happens by accident: a scan is "use" unless the scanner said otherwise; and text
  // that isn't a barcode changes nothing.
  const junk = await sim.scan('<script>alert(1)</script>');
  expect(junk?.status).toBe('not_pantry');
  expect(await stockOf(yoghurt.productId)).toBe(6);
});

test('an unknown barcode waits, is linked once and applied; no stock goes on the shopping list', async ({ page }, testInfo) => {
  const t = tag(testInfo.project.name);
  const soap = await seedProduct(`${t} Soap`, 3, true);
  const icecream = await seedProduct(`${t} Ice cream`, 0);
  const sim = await addScanner(page, `${t} Scanner 2`);

  await page.goto('/pantry/scanner');
  await expect(page.getByRole('heading', { name: 'Bin scanner', level: 1 })).toBeVisible();
  await page.waitForTimeout(1500);

  // Two soap wrappers with a barcode Gedara has never seen.
  const code = randomBarcode();
  expect((await sim.scan(code))?.status).toBe('unknown');
  expect((await sim.scan(code))?.status).toBe('unknown');
  expect(await stockOf(soap.productId)).toBe(3);
  const needs = page.getByTestId('scanner-needs').getByTestId('scanner-scan').filter({ hasText: code });
  await expect(needs).toHaveCount(1); // one card for the code, both scans behind it
  await needs.getByRole('button', { name: 'Link to a product' }).click();
  const form = page.getByTestId('scanner-link-form');
  await form.getByLabel('Find a product').fill(`${t} Soap`);
  await form.getByLabel('Product', { exact: true }).selectOption({ label: `${t} Soap` });
  await form.getByRole('button', { name: /Link and apply/ }).click();
  await expect.poll(() => stockOf(soap.productId)).toBe(1); // both waiting scans applied
  await expect(page.getByTestId('scanner-needs').getByTestId('scanner-scan').filter({ hasText: code })).toHaveCount(0);
  // …and from now on that barcode just works.
  expect((await sim.scan(code))?.status).toBe('used');
  expect(await stockOf(soap.productId)).toBe(0);

  // An empty ice-cream tub that was never in stock: nothing to take, so it goes on the list.
  const none = await sim.scan(icecream.barcode!);
  expect(none?.status).toBe('no_stock');
  expect(none?.on_list).toBe(true);
  await expect(page.getByTestId('scanner-recent').getByTestId('scanner-scan').filter({ hasText: `${t} Ice cream` }).first()).toHaveAttribute(
    'data-status',
    'no_stock',
  );
  const { data: list } = await userClient().from('shopping_list_item').select('source, done').eq('product_id', icecream.productId);
  expect(list).toEqual([{ source: 'scanner', done: false }]);
});

test('# Check on a new barcode only links it: the pop-up suggests the product, nothing is used', async ({ page }, testInfo) => {
  const t = tag(testInfo.project.name);
  // A product from a bill: in stock, no barcode yet.
  const lentils = await seedProduct(`${t} Red lentils`, 2, true);
  const sim = await addScanner(page, `${t} Scanner 3`);

  await page.goto('/pantry');
  await expect(page.getByRole('heading', { name: 'Pantry', level: 1 })).toBeVisible();
  await page.waitForTimeout(1500);

  const code = randomBarcode();
  expect((await sim.scan(code, 'check'))?.status).toBe('unknown');
  const popup = page.getByTestId('scanner-popups').getByTestId('scanner-scan').filter({ hasText: code });
  await expect(popup.getByTestId('scanner-scan-title')).toHaveText('Link this barcode', { timeout: 3000 });
  await popup.getByRole('button', { name: 'Link to a product' }).click();

  const form = page.getByTestId('scanner-link-form');
  await expect(form).toContainText('Link only');
  const suggestion = form.getByTestId('scanner-link-suggestions').getByRole('button', { name: new RegExp(`${t} Red lentils`) });
  await expect(suggestion).toContainText('no barcode yet');
  await suggestion.click();
  await expect(suggestion).toHaveAttribute('aria-pressed', 'true');
  await form.getByRole('button', { name: 'Link', exact: true }).click();

  await expect
    .poll(async () => (await userClient().from('product_barcode').select('product_id').eq('barcode', code)).data?.[0]?.product_id)
    .toBe(lentils.productId);
  expect(await stockOf(lentils.productId)).toBe(2); // linked only: nothing used or added
  // …and the next scan of it at the bin just works.
  expect((await sim.scan(code))?.status).toBe('used');
  expect(await stockOf(lentils.productId)).toBe(1);
});
