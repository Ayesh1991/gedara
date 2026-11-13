import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { STORAGE_STATE, stagingAdmin } from './staging-guard';

// Phase 12 "done when" on staging, phone (375) and iPad (1024):
// * Quick spend opens on its own page with its own manifest; amount → one tile saves a cash expense
//   from the person's wallet, now, by them; Undo deletes it; it is an ordinary Money entry.
// * The five seconds, measured: with the CPU slowed 4× the pad is ready within 2 s and four taps
//   later the entry shows as saved.
// * Offline run: three entries with no network, the page reloaded with no network still opens,
//   "3 waiting" shows; back online they are sent in one go, in order, counted once — and sending the
//   same entries again (another phone, a retry) changes nothing.
// * Places search finds a place by its path and by a thing kept in it.
// Everything made here is removed afterwards (entries by this test's op ids, the seeded place/thing).
test.use({ storageState: STORAGE_STATE });

const token = (project: string) => `e2eq${project.startsWith('phone') ? 'p' : 'i'}`;
const opIds = new Set<string>();

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

async function household(): Promise<string> {
  const { data, error } = await userClient().from('household_member').select('household_id').limit(1).single();
  if (error) throw error;
  return data.household_id;
}

/** The op ids the page has queued so far (they stay on the phone until sent). */
async function rememberOps(page: Page) {
  const ids = await page.evaluate(async () => {
    const req = indexedDB.open('gedara-offline');
    const db = await new Promise<IDBDatabase>((ok, ko) => {
      req.onsuccess = () => ok(req.result);
      req.onerror = () => ko(req.error);
    });
    const tx = db.transaction('kv').objectStore('kv').get('outbox');
    const ops = await new Promise<Array<{ op_id: string; kind: string }>>((ok) => (tx.onsuccess = () => ok(tx.result ?? [])));
    return ops.filter((o) => o.kind === 'spend').map((o) => o.op_id);
  });
  ids.forEach((i) => opIds.add(i));
}

/** Every entry id the page sends to the database (so the test checks and removes only its own). */
function watchOps(page: Page) {
  page.on('request', (r) => {
    if (!r.url().includes('/rpc/rpc_quick_spend')) return;
    const body = r.postDataJSON() as { p_ops?: Array<{ op_id: string }> } | null;
    body?.p_ops?.forEach((o) => opIds.add(o.op_id));
  });
}

async function entries(hh: string) {
  if (opIds.size === 0) return [];
  const { data, error } = await stagingAdmin()
    .from('quick_entry')
    .select('op_id, transaction_id, amount, client_at')
    .eq('household_id', hh)
    .in('op_id', [...opIds]);
  if (error) throw error;
  return data;
}

async function enter(page: Page, digits: string, tile: string) {
  for (const d of digits) await page.getByTestId(`quick-pad-${d}`).click();
  await page.getByTestId(`quick-tile-${tile}`).click();
}

test.afterAll(async ({}, testInfo) => {
  const admin = stagingAdmin();
  const hh = await household();
  if (opIds.size) {
    const rows = await entries(hh);
    const tx = rows.map((r) => r.transaction_id).filter((x): x is string => Boolean(x));
    if (tx.length) {
      const r = await admin.from('money_transaction').delete().in('id', tx);
      if (r.error) throw r.error;
    }
    const r = await admin.from('quick_entry').delete().eq('household_id', hh).in('op_id', [...opIds]);
    if (r.error) throw r.error;
  }
  const like = `%${token(testInfo.project.name)}%`;
  for (const table of ['asset', 'location'] as const) {
    const r = await admin.from(table).delete().like('name', like);
    if (r.error) throw r.error;
  }
});

test('Quick spend: one tap saves, Undo, its own icon, and the five seconds', async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const hh = await household();
  watchOps(page);
  // The five seconds: the CPU slowed 4× (a mid-range phone), the app's files already cached.
  await page.goto('/quick');
  await expect(page.getByTestId('quick-tile-tuk')).toBeVisible();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  const t0 = Date.now();
  await page.reload();
  await expect(page.getByTestId('quick-tile-tuk')).toBeVisible();
  const ready = Date.now() - t0;
  const t1 = Date.now();
  await enter(page, '350', 'tuk');
  await expect(page.getByTestId('quick-saved')).toContainText('350');
  const saved = Date.now() - t1;
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  testInfo.annotations.push({ type: 'quick-speed', description: `pad ready ${ready} ms, four taps to saved ${saved} ms` });
  console.log(`[${testInfo.project.name}] Quick spend: pad ready ${ready} ms, four taps to saved ${saved} ms`);
  expect(ready).toBeLessThan(2000);
  expect(ready + saved).toBeLessThan(5000);

  // Its own icon: Quick spend's manifest and name on this page.
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', '/quick.webmanifest');
  await expect(page).toHaveTitle(/Quick spend/);

  // Saved once, as an ordinary expense from the wallet, by the signed-in person, on Transport › Taxi.
  await expect.poll(async () => (await entries(hh)).filter((e) => e.amount === 350 && e.transaction_id).length).toBe(1);
  const mine = (await entries(hh)).filter((e) => e.amount === 350);
  const tx = (await stagingAdmin().from('money_transaction')
    .select('type, total, source, account:account_id (kind), transaction_line (raw_name, destiny, category:category_id (name))')
    .eq('id', mine[0]!.transaction_id!).single()).data as unknown as {
      type: string; total: number; source: string; account: { kind: string };
      transaction_line: Array<{ raw_name: string; destiny: string; category: { name: string } }>;
    };
  expect([tx.type, tx.total, tx.source, tx.account.kind]).toEqual(['expense', 350, 'manual', 'cash']);
  expect(tx.transaction_line[0]).toMatchObject({ raw_name: 'Three-wheeler', destiny: 'expense', category: { name: 'Taxi / PickMe / Uber' } });

  // Undo takes it away again (through the money RPC).
  await page.getByTestId('quick-undo').click();
  await expect.poll(async () => (await stagingAdmin().from('money_transaction').select('id').eq('id', mine[0]!.transaction_id!)).data?.length).toBe(0);
  await expect(page.getByTestId('quick-today')).not.toContainText('Three-wheeler');

  // Reachable from Home and Money.
  await page.goto('/');
  await expect(page.getByTestId('home-quick')).toBeVisible();
  await page.goto('/money');
  await expect(page.getByTestId('money-quick')).toBeVisible();
});

test('Quick spend offline: kept on the phone, sent later in order, counted once', async ({ page, context }) => {
  test.setTimeout(150_000);
  const hh = await household();
  watchOps(page);
  await page.goto('/quick');
  await expect(page.getByTestId('quick-tile-bus')).toBeVisible();
  // Let the service worker take the page (it serves the shell with no network).
  await page.waitForFunction(() => navigator.serviceWorker?.controller !== null, null, { timeout: 30_000 });

  await context.setOffline(true);
  await enter(page, '60', 'bus');
  await enter(page, '120', 'short_eats');
  await enter(page, '450', 'meal');
  await expect(page.getByTestId('quick-waiting')).toContainText('3');
  await rememberOps(page);
  expect(opIds.size).toBeGreaterThanOrEqual(3);

  // The hospital basement: the app is closed and opened again with no signal.
  await page.reload();
  await expect(page.getByTestId('quick-tile-bus')).toBeVisible();
  await expect(page.getByTestId('quick-waiting')).toContainText('3');
  await page.getByTestId('quick-waiting').click();
  await expect(page.getByTestId('quick-waiting-why')).toBeVisible();
  await page.keyboard.press('Escape');
  expect((await entries(hh)).filter((e) => e.transaction_id).length).toBe(0);

  await context.setOffline(false);
  await expect(page.getByTestId('quick-waiting')).toHaveCount(0, { timeout: 30_000 });
  const sent = (await entries(hh)).filter((e) => e.amount !== 350).sort((a, b) => a.client_at.localeCompare(b.client_at));
  expect(sent.map((e) => e.amount)).toEqual([60, 120, 450]);

  // Another phone (or a retry after a lost answer) sends the very same entries again: nothing changes.
  const again = await userClient().rpc('rpc_quick_spend', {
    p_household: hh,
    p_ops: sent.map((e) => ({ op_id: e.op_id, label: 'again', amount: e.amount, client_at: e.client_at, fingerprint: 'mzz', line_tail: 'zz' })),
  });
  expect(again.error).toBeNull();
  expect((again.data as Array<{ status: string }>).map((r) => r.status)).toEqual(['replayed', 'replayed', 'replayed']);
  const txIds = (await entries(hh)).filter((e) => e.amount !== 350).map((e) => e.transaction_id);
  const { data: txs } = await stagingAdmin().from('money_transaction').select('id, total').in('id', txIds as string[]);
  expect(txs!.reduce((s, t) => s + Number(t.total), 0)).toBe(630);
});

test('Places: search by path and by what is kept there', async ({ page }, testInfo) => {
  const hh = await household();
  const db = userClient();
  const tag = token(testInfo.project.name);
  const room = (await db.from('location').insert({ household_id: hh, name: `${tag} Study`, kind: 'room' }).select('id').single()).data!;
  const box = (await db.from('location').insert({ household_id: hh, name: `${tag} Drawer`, kind: 'container', parent_id: room.id }).select('id').single()).data!;
  await db.from('asset').insert({ household_id: hh, name: `${tag} Passport`, location_id: box.id });

  await page.goto('/places');
  const search = page.getByRole('searchbox');
  await search.fill(`${tag} study drawer`);
  await expect(page.getByTestId('places-results')).toContainText(`${tag} Drawer`);
  await search.fill(`${tag} passport`);
  await expect(page.getByTestId('places-results')).toContainText(`${tag} Study › ${tag} Drawer`);
  await expect(page.getByTestId('places-results')).toContainText(`${tag} Passport`);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
