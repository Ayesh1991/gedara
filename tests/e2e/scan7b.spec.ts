import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { STORAGE_STATE, stagingAdmin } from './staging-guard';

// Phase 7b "Scan & photo everywhere": camera/USB barcode fields, photos in place, Quick add,
// Put in a place / Fill this box (with Undo, and offline), blank label sheets (print, reprint,
// claim as a new box → fill it, extra label on a thing, detach). Everything is named
// "E2E-7B <p|i> …" and removed afterwards with the staging service-role client, including the
// blank sheets this spec printed (staging only; real sheets are never deleted).
test.use({ storageState: STORAGE_STATE });

const token = (project: string) => `E2E-7B ${project.startsWith('phone') ? 'p' : 'i'}`;
const BUCKET = 'household-files';
const sheetsMade: string[] = [];

test.afterAll(async ({}, testInfo) => {
  const admin = stagingAdmin();
  const like = `${token(testInfo.project.name)}%`;
  if (sheetsMade.length) {
    const r = await admin.from('label_sheet').delete().in('id', sheetsMade);
    if (r.error) throw r.error;
  }
  const { data: assets } = await admin.from('asset').select('id').like('name', like);
  const { data: products } = await admin.from('product').select('id').like('name', like);
  const { data: places } = await admin.from('location').select('id, parent_id').like('name', like);
  const ids = [...(assets ?? []), ...(products ?? []), ...(places ?? [])].map((x) => x.id);
  if (ids.length) {
    const { data: files } = await admin.from('attachment').select('storage_path, thumb_path').in('entity_id', ids);
    const paths = (files ?? []).flatMap((f) => [f.storage_path, f.thumb_path]).filter((p): p is string => Boolean(p));
    if (paths.length) await admin.storage.from(BUCKET).remove(paths);
    await admin.from('attachment').delete().in('entity_id', ids);
  }
  if (assets?.length) {
    const r = await admin.from('asset').delete().in('id', assets.map((a) => a.id));
    if (r.error) throw r.error;
  }
  const productIds = (products ?? []).map((p) => p.id);
  if (productIds.length) {
    for (const table of ['stock_movement', 'stock_lot', 'product_barcode', 'product'] as const) {
      const r = await admin.from(table).delete().in(table === 'product' ? 'id' : 'product_id', productIds);
      if (r.error) throw r.error;
    }
  }
  // Places: children before parents (a place with places inside can't be deleted).
  let left = places ?? [];
  for (let round = 0; left.length && round < 6; round++) {
    const parents = new Set(left.map((p) => p.parent_id).filter(Boolean));
    const leaves = left.filter((p) => !parents.has(p.id)).map((p) => p.id);
    if (!leaves.length) break;
    const r = await admin.from('location').delete().in('id', leaves);
    if (r.error) throw r.error;
    left = left.filter((p) => !leaves.includes(p.id));
  }
});

async function noSidewaysScroll(page: Page, label: string) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, label).toBeLessThanOrEqual(0);
}

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

/** A valid EAN-13 nobody has (random body + check digit). */
function ean(): string {
  const body = `29${Math.floor(Math.random() * 1e10).toString().padStart(10, '0')}`;
  const sum = [...body].reverse().reduce((acc, d, i) => acc + Number(d) * (i % 2 === 0 ? 3 : 1), 0);
  return body + ((10 - (sum % 10)) % 10);
}

interface Seeded {
  household: string;
  box: { id: string; code: string; name: string };
  shelf: { id: string; code: string; name: string };
  tin: { id: string; code: string; name: string };
  drill: { id: string; code: string; name: string };
  rice: { id: string; code: string; name: string };
}

/** A box, a shelf, a small tin (place), a drill (thing) and rice with 1 kg in stock. */
async function seed(tag: string): Promise<Seeded> {
  stagingAdmin(); // refuses unless this is staging
  const db = userClient();
  const { data: member, error: mErr } = await db.from('household_member').select('household_id').limit(1).single();
  if (mErr) throw mErr;
  const household = member.household_id as string;
  const place = async (name: string, kind: string) => {
    const r = await db.from('location').insert({ household_id: household, name, kind }).select('id, code, name').single();
    if (r.error) throw r.error;
    return r.data as Seeded['box'];
  };
  const box = await place(`${tag} Box`, 'container');
  const shelf = await place(`${tag} Shelf`, 'shelf');
  const tin = await place(`${tag} Tin`, 'container');
  const a = await db.from('asset').insert({ household_id: household, name: `${tag} Drill` }).select('id, code, name').single();
  if (a.error) throw a.error;
  const g = await db.from('unit').select('id').is('household_id', null).eq('code', 'g').single();
  if (g.error) throw g.error;
  const p = await db
    .from('product')
    .insert({ household_id: household, name: `${tag} Rice`, stock_unit_id: g.data.id, due_type: 'none' })
    .select('id, code, name')
    .single();
  if (p.error) throw p.error;
  const buy = await db.rpc('rpc_purchase', { p: { household_id: household, product_id: p.data.id, qty: 1000, total_cost: 300 } });
  if (buy.error) throw buy.error;
  return { household, box, shelf, tin, drill: a.data as Seeded['drill'], rice: p.data as Seeded['rice'] };
}

/** Type a code into the Scan screen, as pasting or a USB scanner would. */
async function typeCode(page: Page, code: string) {
  await page.getByLabel('Or type the code').fill(code);
  await page.getByRole('button', { name: 'Find' }).click();
}

const PNG = {
  name: 'photo.png',
  mimeType: 'image/png',
  buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64'),
};

test('barcode fields take camera or USB scans; photos are taken, replaced and removed in place', async ({ page }, testInfo) => {
  test.setTimeout(150_000);
  const tag = `${token(testInfo.project.name)} ${Date.now().toString(36)}`;
  const s = await seed(tag);
  const db = userClient();

  // ── Product page › Barcodes: a USB scan (typed + Enter) adds it at once ──────
  await page.goto(`/pantry/${s.rice.id}`);
  await expect(page.getByRole('heading', { name: s.rice.name, level: 1 })).toBeVisible();
  const code = ean();
  const field = page.getByLabel('Barcode', { exact: true });
  await field.fill(code);
  await field.press('Enter');
  await expect(page.getByText(code, { exact: true })).toBeVisible();
  const bc = await db.from('product_barcode').select('barcode').eq('product_id', s.rice.id);
  expect(bc.data?.map((b) => b.barcode)).toContain(code);
  // The camera button opens the scanner sheet (the camera itself is checked on a real phone).
  await page.getByRole('button', { name: 'Scan with the camera' }).first().click();
  await expect(page.getByTestId('scan-sheet')).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click();
  await noSidewaysScroll(page, '/pantry/:id');

  // ── Place photo: pencil → gallery → replace → remove ─────────────────────────
  await page.goto(`/places/${s.box.id}`);
  await expect(page.getByRole('heading', { name: s.box.name, level: 1 })).toBeVisible();
  await page.getByTestId('photo-edit').click();
  await expect(page.getByRole('button', { name: 'Take a photo' })).toBeVisible();
  await page.getByRole('dialog').getByTestId('photo-gallery-input').setInputFiles(PNG);
  await expect(page.locator('[data-sonner-toast]').filter({ hasText: 'Photo added' })).toBeVisible({ timeout: 20_000 });
  await page.getByTestId('photo-edit').click();
  await page.getByRole('dialog').getByTestId('photo-gallery-input').setInputFiles(PNG);
  await expect(page.locator('[data-sonner-toast]').filter({ hasText: 'Photo replaced' })).toBeVisible({ timeout: 20_000 });
  const photos = await db.from('attachment').select('id').eq('entity_id', s.box.id).eq('is_primary', true);
  expect(photos.data).toHaveLength(1);
  await page.getByTestId('photo-edit').click();
  await page.getByRole('dialog').getByRole('button', { name: 'Remove photo' }).click();
  await expect(page.locator('[data-sonner-toast]').filter({ hasText: 'Photo removed' })).toBeVisible({ timeout: 20_000 });
  const none = await db.from('attachment').select('id').eq('entity_id', s.box.id);
  expect(none.data).toHaveLength(0);
});

test('Quick add: three products in a row, each from a scanned barcode', async ({ page }, testInfo) => {
  test.setTimeout(150_000);
  const tag = `${token(testInfo.project.name)} ${Date.now().toString(36)}`;
  await page.goto('/pantry');
  await page.getByRole('link', { name: 'Add many' }).click();
  await expect(page.getByTestId('scan-mode')).toContainText('Add products');
  await noSidewaysScroll(page, '/scan?add=product');
  const codes = [ean(), ean(), ean()];
  for (const [i, c] of codes.entries()) {
    await typeCode(page, c);
    const form = page.getByRole('dialog');
    await expect(form.getByLabel('Name', { exact: true })).toBeVisible();
    await form.getByLabel('Name', { exact: true }).fill(`${tag} Item ${i + 1}`);
    await form.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(form).toBeHidden();
    await expect(page.getByTestId('added-list')).toContainText(`${tag} Item ${i + 1}`);
  }
  await expect(page.getByTestId('added-list').getByRole('link')).toHaveCount(3);
  const db = userClient();
  const found = await db.from('product_barcode').select('barcode').in('barcode', codes);
  expect(found.data).toHaveLength(3);
});

test('Put in a place and Fill this box, with Undo', async ({ page }, testInfo) => {
  test.setTimeout(150_000);
  const tag = `${token(testInfo.project.name)} ${Date.now().toString(36)}`;
  const s = await seed(tag);
  const db = userClient();
  const where = async () => (await db.from('asset').select('location_id').eq('id', s.drill.id).single()).data?.location_id;

  // ── 4a: scan the thing → "Put in a place" → scan the box ────────────────────
  await page.goto('/scan');
  await typeCode(page, s.drill.code);
  await page.getByTestId('scan-result').getByRole('link', { name: 'Put in a place' }).click();
  await expect(page.getByTestId('scan-mode')).toContainText(`Put ${s.drill.name} in a place`);
  await typeCode(page, s.box.code);
  const moved = page.locator('[data-sonner-toast]').filter({ hasText: `${s.drill.name} → ${s.box.name}` });
  await expect(moved).toBeVisible();
  await expect.poll(where).toBe(s.box.id);
  await moved.getByRole('button', { name: 'Undo' }).click();
  await expect.poll(where).toBeNull();
  await noSidewaysScroll(page, '/scan?put=');

  // ── 4b: Fill the shelf with the drill, the rice and the tin; undo the tin ────
  await page.goto(`/places/${s.shelf.id}`);
  await page.getByRole('button', { name: 'Fill' }).click();
  await expect(page.getByTestId('scan-mode')).toContainText('Filling');
  for (const c of [s.drill.code, s.rice.code, s.tin.code]) await typeCode(page, c);
  const rows = page.getByTestId('fill-row');
  await expect(rows).toHaveCount(3);
  await expect.poll(where).toBe(s.shelf.id);
  await expect
    .poll(async () => (await db.from('stock_lot').select('location_id').eq('product_id', s.rice.id).gt('qty_remaining', 0)).data?.map((l) => l.location_id))
    .toEqual([s.shelf.id]);
  const tinParent = async () => (await db.from('location').select('parent_id').eq('id', s.tin.id).single()).data?.parent_id;
  await expect.poll(tinParent).toBe(s.shelf.id);
  await rows.filter({ hasText: s.tin.name }).getByRole('button', { name: /Undo/ }).click();
  await expect.poll(tinParent).toBeNull();
  await noSidewaysScroll(page, '/scan?fill=');
});

test('blank label sheets: print, reprint, claim as a new box, fill it, extra label, detach', async ({ page }, testInfo) => {
  test.setTimeout(200_000);
  const tag = `${token(testInfo.project.name)} ${Date.now().toString(36)}`;
  const s = await seed(tag);
  const db = userClient();

  // ── Print two new A4 sheets (staging: TEST labels, confirmed) ────────────────
  await page.goto('/places');
  await page.getByRole('link', { name: 'Blank labels' }).click();
  await expect(page.getByRole('heading', { name: 'Blank labels', level: 1 })).toBeVisible();
  await expect(page.getByTestId('blank-test-warning')).toBeVisible();
  await noSidewaysScroll(page, '/places/blank-labels');
  const before = await db.from('label_sheet').select('sheet_no').order('sheet_no', { ascending: false }).limit(1);
  const last = before.data?.[0]?.sheet_no ?? 0;
  await expect(page.getByRole('button', { name: /Print 1 new sheet/ })).toBeDisabled();
  await page.getByLabel('I understand: print test labels').check();
  await page.getByRole('button', { name: 'More sheets' }).click();
  const [pdf] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Print 2 new sheets' }).click()]);
  expect(pdf.suggestedFilename()).toMatch(/\.pdf$/);
  const made = await db.from('label_sheet').select('id, sheet_no, print_count').gt('sheet_no', last).order('sheet_no');
  sheetsMade.push(...(made.data ?? []).map((x) => x.id));
  // Consecutive and after every sheet ever made (numbers never go back, even after a delete).
  const nos = made.data?.map((x) => x.sheet_no) ?? [];
  expect(nos).toHaveLength(2);
  expect(nos[1]).toBe(nos[0]! + 1);
  const tags = await db.from('label_tag').select('code, slot, sheet_id').in('sheet_id', sheetsMade).order('slot');
  expect(tags.data).toHaveLength(108);
  expect(new Set(tags.data?.map((x) => x.code)).size).toBe(108);

  // ── Reprint the first sheet: same codes, no new sheet ───────────────────────
  const first = page.getByTestId('blank-sheet').filter({ hasText: new RegExp(`Sheet ${nos[0]}(?!\\d)`) });
  const [again] = await Promise.all([page.waitForEvent('download'), first.getByRole('button', { name: 'Print again' }).click()]);
  expect(again.suggestedFilename()).toContain(`sheet-${nos[0]}`);
  await expect
    .poll(async () => (await db.from('label_sheet').select('print_count').eq('id', made.data![0]!.id).single()).data?.print_count)
    .toBe(2);
  expect((await db.from('label_sheet').select('id').gt('sheet_no', last)).data).toHaveLength(2);

  const sheet1 = (tags.data ?? []).filter((x) => x.sheet_id === made.data![0]!.id);
  const [boxLabel, thingLabel] = [sheet1[0]!.code, sheet1[1]!.code];

  // ── Phone camera on a blank A4 label → "New label — what is this?" → New Box ─
  await page.goto(`/s/${boxLabel}`);
  await expect(page.getByTestId('claim-panel')).toBeVisible();
  await page.getByRole('button', { name: 'New Box' }).click();
  const form = page.getByRole('dialog');
  await form.getByLabel('Name', { exact: true }).fill(`${tag} Tagged box`);
  await form.getByRole('button', { name: 'Add place' }).click();
  await expect(page.getByTestId('claimed')).toContainText(`${tag} Tagged box`);
  const tagged = await db.from('location').select('id').eq('name', `${tag} Tagged box`).single();
  const boxTag = await db.from('label_tag').select('location_id').eq('code', boxLabel).single();
  expect(boxTag.data?.location_id).toBe(tagged.data?.id);

  // … and straight into "Fill this box"
  await page.getByTestId('claimed').getByRole('link', { name: 'Fill this box' }).click();
  await expect(page.getByTestId('scan-mode')).toContainText(`${tag} Tagged box`);
  await typeCode(page, s.drill.code);
  await expect(page.getByTestId('fill-row')).toHaveCount(1);
  await expect
    .poll(async () => (await db.from('asset').select('location_id').eq('id', s.drill.id).single()).data?.location_id)
    .toBe(tagged.data?.id);

  // ── A second label on a thing that already has its own ──────────────────────
  await page.goto('/scan');
  await typeCode(page, thingLabel);
  await page.getByTestId('claim-panel').getByRole('button', { name: 'An existing thing' }).click();
  const picker = page.getByRole('dialog');
  await picker.getByLabel('Search').fill(s.drill.name);
  await picker.getByRole('button', { name: new RegExp(s.drill.name) }).click();
  await expect(page.getByTestId('claimed')).toBeVisible();
  await page.goto(`/s/${thingLabel}`);
  await expect(page).toHaveURL(new RegExp(`/things/${s.drill.id}$`));
  await expect(page.getByTestId('extra-labels')).toContainText(thingLabel);

  // ── Detach: the sticker is blank again ──────────────────────────────────────
  await page.getByTestId('extra-labels').getByRole('button', { name: 'Detach' }).click();
  await expect(page.getByTestId('extra-labels')).toBeHidden();
  const blank = await db.from('label_tag').select('asset_id, retired_at').eq('code', thingLabel).single();
  expect(blank.data).toEqual({ asset_id: null, retired_at: null });
});

test('offline: Fill this box queues moves on the phone and syncs them', async ({ page, context }, testInfo) => {
  test.setTimeout(150_000);
  const tag = `${token(testInfo.project.name)} ${Date.now().toString(36)}`;
  const s = await seed(tag);
  const db = userClient();

  // Online, as a person would: open the box, look at Pantry and Things (in the app, no reload), come
  // back and tap Fill. Those screens' data is what the phone resolves scans from when offline.
  await page.goto(`/places/${s.box.id}`);
  await expect(page.getByRole('heading', { name: s.box.name, level: 1 })).toBeVisible();
  await page.getByRole('link', { name: 'Pantry', exact: true }).first().click();
  await expect(page.getByText(s.rice.name).first()).toBeVisible();
  await page.getByRole('link', { name: 'Things', exact: true }).first().click();
  await expect(page.getByText(s.drill.name).first()).toBeVisible();
  await page.goBack();
  await page.goBack();
  await expect(page.getByRole('heading', { name: s.box.name, level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Fill' }).click();
  await expect(page.getByTestId('scan-mode')).toContainText(s.box.name);

  await context.setOffline(true);
  await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(false);
  await typeCode(page, s.drill.code);
  await typeCode(page, s.rice.code);
  const rows = page.getByTestId('fill-row');
  await expect(rows).toHaveCount(2);
  await expect(page.getByTestId('offline-banner')).toContainText(/2 (actions )?waiting/);

  await context.setOffline(false);
  await expect(page.locator('[data-sonner-toast]').filter({ hasText: '2 offline actions synced' }).first()).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(async () => (await db.from('asset').select('location_id').eq('id', s.drill.id).single()).data?.location_id)
    .toBe(s.box.id);
  await expect
    .poll(async () => (await db.from('stock_lot').select('location_id').eq('product_id', s.rice.id).gt('qty_remaining', 0)).data?.map((l) => l.location_id))
    .toEqual([s.box.id]);
});
