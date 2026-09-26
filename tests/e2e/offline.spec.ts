import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { STORAGE_STATE, stagingAdmin } from './staging-guard';

// Phase 7 "done when": works offline for scan-and-consume. The app starts with no network (service
// worker + saved catalogue), a product label typed on the Scan screen resolves from the saved
// catalogue, "Use" and the pantry card's −1 queue on the phone, a shopping-list tick queues too.
// Meanwhile "the other phone" (a signed-in client outside the browser) uses most of the stock. Back
// online: the queue replays in order, the op that no longer fits is parked in "Couldn't sync"
// (nothing changes silently), and sending an op a second time never takes stock twice.
// Everything created carries "e2eoff<p|i>…" and is removed afterwards.
test.use({ storageState: STORAGE_STATE });

const token = (project: string) => `e2eoff${project.startsWith('phone') ? 'p' : 'i'}`;

test.afterAll(async ({}, testInfo) => {
  const admin = stagingAdmin();
  const like = `%${token(testInfo.project.name)}%`;
  const { data: products, error } = await admin.from('product').select('id').like('name', like);
  if (error) throw error;
  const ids = products.map((p) => p.id);
  if (ids.length) {
    const lots = await admin.from('stock_lot').select('id').in('product_id', ids);
    if (lots.error) throw lots.error;
    const ops = await admin.from('stock_movement').select('correlation_id').in('product_id', ids);
    if (ops.error) throw ops.error;
    const corr = [...new Set(ops.data.map((o) => o.correlation_id))];
    if (corr.length) {
      const r = await admin.from('stock_op').delete().in('correlation_id', corr);
      if (r.error) throw r.error;
    }
    for (const table of ['stock_movement', 'stock_lot', 'product'] as const) {
      const r = await admin.from(table).delete().in(table === 'product' ? 'id' : 'product_id', ids);
      if (r.error) throw r.error;
    }
  }
  const list = await admin.from('shopping_list_item').delete().like('free_text', like);
  if (list.error) throw list.error;
});

/** The e2e user (saved session): stock only moves through the RPCs, as that user. */
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

async function seed(tag: string) {
  stagingAdmin(); // refuses unless this is staging
  const db = userClient();
  const { data: member, error: mErr } = await db.from('household_member').select('household_id').limit(1).single();
  if (mErr) throw mErr;
  const household = member.household_id;
  const { data: pcs, error: uErr } = await db.from('unit').select('id').is('household_id', null).eq('code', 'pcs').single();
  if (uErr) throw uErr;
  const product = await db
    .from('product')
    .insert({ household_id: household, name: `Milk ${tag}`, stock_unit_id: pcs.id, quick_consume_qty: 1 })
    .select('id, name, code')
    .single();
  if (product.error) throw product.error;
  const buy = await db.rpc('rpc_purchase', { p: { household_id: household, product_id: product.data.id, qty: 5, total_cost: 1000 } });
  if (buy.error) throw buy.error;
  const item = await db
    .from('shopping_list_item')
    .insert({ household_id: household, free_text: `Candles ${tag}` })
    .select('id')
    .single();
  if (item.error) throw item.error;
  return { db, household, product: product.data, itemId: item.data.id };
}

async function stockOf(productId: string): Promise<number> {
  const { data, error } = await stagingAdmin().from('stock_lot').select('qty_remaining').eq('product_id', productId);
  if (error) throw error;
  return data.reduce((s, l) => s + Number(l.qty_remaining), 0);
}

/** The service worker controls the page and has cached every file of the offline shell. */
async function readyForOffline(page: Page) {
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          if (!navigator.serviceWorker.controller) return -1;
          const sw = await (await fetch('/sw.js')).text();
          const wanted = new Set([...sw.matchAll(/"url":"([^"]+)"/g)].map((m) => new URL(m[1]!, location.origin + '/').href));
          const have = new Set<string>();
          for (const k of (await caches.keys()).filter((x) => x.startsWith('gedara-shell-'))) {
            for (const r of await (await caches.open(k)).keys()) have.add(r.url);
          }
          return [...wanted].filter((u) => !have.has(u)).length;
        }),
      { timeout: 60_000, message: 'files of the offline shell still missing' },
    )
    .toBe(0);
}

test('offline: scan-and-consume and ticks queue on the phone and sync safely', async ({ page, context }, testInfo) => {
  test.setTimeout(180_000);
  const tag = `${token(testInfo.project.name)}${Date.now().toString(36)}`;
  const { db, household, product, itemId } = await seed(tag);

  // ── Online: open the screens once (their data is saved for offline) ─────────
  await page.goto('/pantry');
  await expect(page.getByRole('heading', { name: 'Pantry', level: 1 })).toBeVisible();
  await expect(page.getByText(product.name).first()).toBeVisible();
  await page.reload();
  await readyForOffline(page);
  await page.goto('/pantry/list');
  await expect(page.getByText(`Candles ${tag}`)).toBeVisible();
  await page.goto('/pantry');
  await expect(page.getByText(product.name).first()).toBeVisible();
  await page.waitForTimeout(2000); // the saved catalogue is written at most once a second

  // ── Offline: the app still starts ─────────────────────────────────────────────
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Pantry', level: 1 })).toBeVisible();
  // (Chromium's offline emulation may still report navigator.onLine = true after a reload, like a
  // phone on Wi-Fi without internet: the app must work either way.)
  await expect(page.getByText(product.name).first()).toBeVisible();

  // Scan (typed code) → Use 1: resolved from the saved catalogue, queued.
  await page.goto('/scan');
  await page.getByLabel('Or type the code').fill(product.code);
  await page.getByRole('button', { name: 'Find' }).click();
  const card = page.getByTestId('scan-result');
  await expect(card).toContainText(product.name);
  await card.getByRole('button', { name: /^Use 1 pcs/ }).click();
  await expect(page.locator('[data-sonner-toast]').filter({ hasText: 'Saved on this phone' }).first()).toBeVisible();

  // Pantry card −1: queued as well.
  await page.goto('/pantry');
  await page.getByRole('button', { name: `Use 1 pcs of ${product.name}` }).click();
  await expect(page.getByTestId('offline-banner')).toContainText(/2 (actions )?waiting/);

  // Shopping list tick: shown at once, queued.
  await page.goto('/pantry/list');
  await page.getByRole('button', { name: `Bought Candles ${tag}` }).click();
  await expect(page.locator('[data-sonner-toast]').filter({ hasText: 'Ticked on this phone' }).first()).toBeVisible();
  await expect(page.getByTestId('offline-banner')).toContainText(/3 (actions )?waiting/);

  // Nothing reached the database yet.
  expect(await stockOf(product.id)).toBe(5);

  // Meanwhile the other phone uses 4 of the 5.
  const other = await db.rpc('rpc_consume', { p: { household_id: household, product_id: product.id, qty: 4 } });
  expect(other.error).toBeNull();

  // ── Back online: replay in order; the op that no longer fits is parked ──────
  await context.setOffline(false);
  await page.goto('/pantry');
  await expect(page.locator('[data-sonner-toast]').filter({ hasText: '2 offline actions synced' }).first()).toBeVisible({ timeout: 30_000 });
  const parked = page.getByTestId('couldnt-sync');
  await expect(parked).toContainText(`Used 1 pcs of ${product.name}`);
  await expect(parked).toContainText("There isn't that much in stock.");
  expect(await stockOf(product.id)).toBe(0);
  const tick = await stagingAdmin().from('shopping_list_item').select('done').eq('id', itemId).single();
  expect(tick.data?.done).toBe(true);

  // Exactly one consume from this phone went through (plus the other phone's).
  const moves = await stagingAdmin().from('stock_movement').select('correlation_id').eq('product_id', product.id).eq('reason', 'consume');
  expect(new Set(moves.data?.map((m) => m.correlation_id)).size).toBe(2);

  // Sending the synced op again (a retry after a lost reply) is a replay: nothing moves.
  const ops = await stagingAdmin()
    .from('stock_op')
    .select('op_id, correlation_id')
    .in('correlation_id', [...new Set(moves.data!.map((m) => m.correlation_id))]);
  expect(ops.data).toHaveLength(1);
  await db.rpc('rpc_purchase', { p: { household_id: household, product_id: product.id, qty: 3, total_cost: 600 } });
  const again = await db.rpc('rpc_stock_op', {
    p_op_id: ops.data![0]!.op_id,
    p_action: 'consume',
    p: { household_id: household, product_id: product.id, qty: 1 },
  });
  expect((again.data as { replayed?: boolean } | null)?.replayed).toBe(true);
  expect(await stockOf(product.id)).toBe(3);

  // The parked op: the person decides. Discard it.
  await parked.getByRole('button', { name: 'Discard' }).click();
  await expect(parked).toBeHidden();
  await expect(page.getByTestId('offline-banner')).toBeHidden();
  expect(await stockOf(product.id)).toBe(3);
});
