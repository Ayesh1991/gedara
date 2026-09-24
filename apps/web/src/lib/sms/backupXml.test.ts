import { describe, expect, it } from 'vitest';
import { checkBackupFile, scanBackup } from './backupXml';

const xml = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<!--File Created By SMS Backup & Restore v10.20.002-->
<smses count="7" backup_set="x" backup_date="1789300000000" type="full">
  <sms protocol="0" address="BOC" date="1789202370000" type="1" subject="null" body="ATM Withdrawal Rs 10000.00 From A/C No XXXXXXXXXX319. Balance available Rs 250095.92 - Thank you for banking with BOC" toa="null" sc_toa="null" service_center="null" read="1" status="-1" locked="0" readable_date="Sep 21, 2026 5:40:00 PM" contact_name="(Unknown)" />
  <sms protocol="0" address="Seylan Bank" date="1789202400000" type="1" body="Seylan Card ...6029 debit Txn 1 of LKR 550.00 done on 12/09/2026 01:09:29 PM at M &amp; S &quot;Store&quot;. Avl bal 14,722.11" />
  <sms protocol="0" address="BOC" date="1789202500000" type="1" body="Your OTP is 482913. Do not share it." />
  <sms protocol="0" address="PeoplesCard" date="1789202600000" type="1" body="Enjoy 25% off! STOP SMS?Send NOPROM to0777701961" />
  <sms protocol="0" address="+94771234567" date="1789202700000" type="1" body="Hi, dinner at 8?" />
  <sms protocol="0" address="BOC" date="1789202800000" type="2" body="Rs 5 sent by me" />
  <sms protocol="0" address="SAMPCCTXN" date="1780000000000" type="1" body="Cr Crd no..**6577 Auth Pmt LKR 1.00 at X Avl Bal LKR 1.00 - Sampath Bank 01-JUN" />
</smses>`;

describe('SMS Backup & Restore XML', () => {
  it('keeps only received bank alerts, drops OTPs, promos, people and sent texts', () => {
    const r = scanBackup(xml);
    if ('error' in r) throw new Error(r.error);
    expect(r.total).toBe(7);
    expect(r.messages.map((m) => m.sender)).toEqual(['SAMPCCTXN', 'BOC', 'Seylan Bank']);
    expect(r.bySender).toEqual({ BOC: 1, Seylan: 1, Sampath: 1 });
    expect(r.dropped).toEqual({ otherSenders: 1, sent: 1, secret: 1, promo: 1 });
    expect(r.messages[2]!.body).toContain('M & S "Store"');
    expect(JSON.stringify(r.messages)).not.toMatch(/OTP|dinner/);
  });
  it('a date window limits it to the months you want', () => {
    const r = scanBackup(xml, { from: 1789000000000 });
    if ('error' in r) throw new Error(r.error);
    expect(r.messages).toHaveLength(2);
  });
  it('refuses files that are not a backup, whatever they are called', () => {
    expect(scanBackup('<html><body>hi</body></html>')).toEqual({ error: 'notBackup' });
    expect(checkBackupFile({ type: 'image/png', size: 10 })).toBe('type');
    expect(checkBackupFile({ type: 'text/xml', size: 60 * 1024 * 1024 })).toBe('size');
    expect(checkBackupFile({ type: '', size: 10 })).toBeNull();
  });
});
