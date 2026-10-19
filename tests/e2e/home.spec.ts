import { expect, test } from '@playwright/test';
import { BridgeSim, demoHouse } from '../../devices/home-bridge/tools/sim';
import { STORAGE_STATE, stagingAdmin } from './staging-guard';

// Phase 8 done-when, with the software bridge (devices/home-bridge/tools/sim.ts) speaking the real
// protocol to the real home-agent function: connect Home Assistant with the 8-digit code, choose
// the vaporizer and the emergency light in the chooser, see every room, a window opening turns
// amber within 2 s, switch the AC on and one step warmer, the vaporizer on, a service the bridge
// refuses comes back failed, "Home Assistant didn't answer" when it stays silent, and the page fits
// a 375 px phone. Everything is named "E2E-8 …" and removed afterwards (staging only). One project
// only: a household has at most one bridge, so if a real one is paired on staging this skips.
test.use({ storageState: STORAGE_STATE });

const PREFIX = 'E2E-8';
const P = 'e2e8_';
const agentUrl = () => `${process.env.VITE_SUPABASE_URL!.replace(/\/+$/, '')}/functions/v1/home-agent`;

async function cleanup() {
  const admin = stagingAdmin();
  await admin.from('device').delete().eq('kind', 'home').like('name', `${PREFIX}%`); // entities and commands go with it
}

test.beforeAll(cleanup);
test.afterAll(cleanup);

test('connect Home Assistant, see the rooms, a window opens, switch the AC and the vaporizer', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'ipad-1024', 'one bridge per household');
  test.setTimeout(180_000);
  const admin = stagingAdmin();
  const { count: real } = await admin.from('device').select('id', { count: 'exact', head: true }).eq('kind', 'home').is('revoked_at', null);
  test.skip((real ?? 0) > 0, 'a real Home Assistant bridge is paired on staging');

  const sim = new BridgeSim(agentUrl(), demoHouse(P));
  const code = await sim.pairStart();
  await page.goto('/settings/devices');
  await expect(page.getByRole('heading', { name: 'Home Assistant', level: 2 })).toBeVisible();
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'Connect Home Assistant' });
  await sheet.getByTestId('ha-pair-code').fill(code);
  await sheet.getByLabel('Name', { exact: true }).fill(`${PREFIX} Bridge`);
  await sheet.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.getByTestId('bridge-row')).toContainText(`${PREFIX} Bridge`);
  await expect.poll(() => sim.pairPoll()).toBe('paired');
  sim.start();

  try {
    // The chooser: everything HA has, by room; the owner lets the vaporizer and the emergency light be switched.
    await page.goto('/settings/home-assistant');
    await expect(page.getByTestId('chooser-row')).toHaveCount(7, { timeout: 30_000 });
    await page.getByRole('switch', { name: 'Control Mosquito Vaporizer from Gedara' }).click();
    await expect(page.getByRole('switch', { name: 'Show Mosquito Vaporizer' })).toHaveAttribute('aria-checked', 'true');
    await page.getByRole('switch', { name: 'Control Living Room Emergency Light from Gedara' }).click();
    await expect(page.getByRole('switch', { name: 'Control Living Room Emergency Light from Gedara' })).toHaveAttribute('aria-checked', 'true');

    // The House page: rooms, all closed.
    await page.goto('/house');
    await expect(page.getByRole('heading', { name: 'House', level: 1 })).toBeVisible();
    await expect(page.getByTestId('house-summary')).toContainText('Everything closed');
    await expect(page.getByRole('heading', { name: 'Bedroom', level: 2 })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Living Room', level: 2 })).toBeVisible();

    // A window opens in the house: amber within 2 s.
    const window2 = page.getByTestId('opening-row').filter({ hasText: 'Bedroom Window 2' });
    await expect(window2).not.toHaveAttribute('data-open');
    sim.set(`binary_sensor.${P}bedroom_window_2`, 'on');
    const opened = Date.now();
    await sim.sync(false);
    await expect(window2).toHaveAttribute('data-open', 'true', { timeout: 2000 });
    testInfo.annotations.push({ type: 'latency', description: `${Date.now() - opened} ms from HA to the screen` });
    await expect(page.getByTestId('house-summary')).toContainText('Open: Bedroom Window 2');

    // The AC: on, then one step warmer (27 → 27.5).
    await page.getByRole('switch', { name: 'AC on or off' }).click();
    await expect.poll(() => sim.entity(`climate.${P}bedroom_ac`).state, { timeout: 8000 }).toBe('cool');
    await page.getByRole('button', { name: 'One step warmer' }).click();
    await expect.poll(() => sim.entity(`climate.${P}bedroom_ac`).attrs?.temperature, { timeout: 8000 }).toBe(27.5);
    await expect(page.getByTestId('ac-target')).toHaveText('27.5°');

    // The vaporizer on, from the Bedroom card.
    const vap = page.getByRole('switch', { name: 'Mosquito Vaporizer on or off' });
    await vap.click();
    await expect.poll(() => sim.entity(`switch.${P}mosquito_vaporizer`).state, { timeout: 8000 }).toBe('on');
    await expect(vap).toHaveAttribute('aria-checked', 'true');

    // Something the bridge refuses (a door can't be "turned on"), whatever reaches it: failed, with the reason.
    const { data: door } = await admin.from('home_entity').select('id, household_id, device_id, entity_id')
      .eq('entity_id', `binary_sensor.${P}front_door`).single();
    const { data: bad } = await admin.from('home_command').insert({ household_id: door!.household_id, device_id: door!.device_id,
      entity: door!.id, entity_id: door!.entity_id, action: 'turn_on' }).select('id').single();
    await expect.poll(async () => (await admin.from('home_command').select('status, error').eq('id', bad!.id).single()).data, { timeout: 30_000 })
      .toMatchObject({ status: 'failed', error: expect.stringContaining('refused by the bridge') });

    // Home Assistant stays silent: the screen says so and goes back.
    sim.deaf = true;
    const light = page.getByRole('switch', { name: 'Living Room Emergency Light on or off' });
    await light.click();
    await expect(page.getByText("Home Assistant didn't answer")).toBeVisible({ timeout: 12_000 });
    await expect(light).toHaveAttribute('aria-checked', 'false');
    sim.deaf = false;

    // Phone and iPad: nothing wider than the screen (attached to the report; rule 10).
    for (const [label, size] of [['phone-375', { width: 375, height: 812 }], ['ipad', { width: 1024, height: 1366 }]] as const) {
      await page.setViewportSize(size);
      await page.waitForTimeout(500);
      await page.screenshot({ path: testInfo.outputPath(`house-${label}.png`), fullPage: true });
      const wider = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(wider, `${label}: nothing wider than the screen`).toBeLessThanOrEqual(0);
    }
    await page.goto('/');
    await expect(page.getByTestId('house-card')).toContainText('Open: Bedroom Window 2');
  } finally {
    sim.stop();
  }
});
