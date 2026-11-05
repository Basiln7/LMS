#!/usr/bin/env node
// Reference sender for the payment platform team, and a manual test tool.
//
//   node scripts/send-test-webhook.mjs <payload.json> [url]
//
// Env: WEBHOOK_KEY_ID, WEBHOOK_SECRET (the same pair configured in ENROLLMENT_WEBHOOK_KEYS)
import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const [file, url = 'http://localhost:3000/api/v1/enrollments/sync'] = process.argv.slice(2);
const keyId = process.env.WEBHOOK_KEY_ID;
const secret = process.env.WEBHOOK_SECRET;
if (!file || !keyId || !secret) {
  console.error('usage: WEBHOOK_KEY_ID=.. WEBHOOK_SECRET=.. node scripts/send-test-webhook.mjs <payload.json> [url]');
  process.exit(2);
}

// Sign the exact bytes that are sent.
const body = JSON.stringify(JSON.parse(await readFile(file, 'utf8')));
const timestamp = String(Math.floor(Date.now() / 1000));
const signature = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');

const res = await fetch(url, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-LMS-Key-Id': keyId,
    'X-LMS-Timestamp': timestamp,
    'X-LMS-Signature': `v1=${signature}`,
  },
  body,
});
console.log(res.status, JSON.stringify(await res.json(), null, 2));
// exitCode (not process.exit) lets fetch's sockets close cleanly — avoids a libuv abort on Windows.
process.exitCode = res.ok ? 0 : 1;
