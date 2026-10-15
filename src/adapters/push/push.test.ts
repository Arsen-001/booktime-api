import { test } from 'node:test';
import assert from 'node:assert/strict';
import { androidChannel } from './push.js';

test('канал Android по виду уведомления: записи, напоминания, акции', () => {
  assert.equal(androidChannel(undefined), 'bookings');
  assert.equal(androidChannel('created'), 'bookings');
  assert.equal(androidChannel('staff_booking_cancelled'), 'bookings');
  assert.equal(androidChannel('booking_reminder'), 'reminders');
  assert.equal(androidChannel('order_pickup_reminder'), 'reminders');
  assert.equal(androidChannel('confirm_request'), 'reminders');
  assert.equal(androidChannel('repeat_invite'), 'marketing');
  assert.equal(androidChannel('mailing'), 'marketing');
});
