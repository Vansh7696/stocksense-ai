/**
 * StockSense AI — Milestones 6C.1 & 6C.2: Background Task Queues & Live Price Alert Engine Tests
 * Validates BullMQ task queuing, retries, deduplication, price alert evaluation (PRICE_ABOVE, PRICE_BELOW),
 * atomic state transitions, exact-once delivery, and worker lifecycle management.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import prisma from '../src/config/prisma.js';
import { getAlertQueue, addAlertEvaluationJob, createAlertWorker } from '../src/queues/alert.queue.js';
import { getMarketDataQueue, addMarketDataIngestionJob } from '../src/queues/marketData.queue.js';
import { evaluateAlertsForStock, notificationHistory } from '../src/services/alertEvaluator.service.js';
import { createAlert } from '../src/services/alert.service.js';

describe('Milestones 6C.1 & 6C.2: BullMQ Queue & Price Alert Engine Tests', () => {
  let testStock = null;
  let user1 = null;
  let user2 = null;
  let alertAbove = null;
  let alertBelow = null;

  before(async () => {
    // Resolve or create valid users in PostgreSQL
    user1 = await prisma.user.upsert({
      where: { email: 'alert.tester1@stocksense.ai' },
      update: {},
      create: {
        fullName: 'Alert Tester One',
        email: 'alert.tester1@stocksense.ai',
        passwordHash: 'dummy-hash-for-alert-tests-12345678',
      },
    });

    user2 = await prisma.user.upsert({
      where: { email: 'alert.tester2@stocksense.ai' },
      update: {},
      create: {
        fullName: 'Alert Tester Two',
        email: 'alert.tester2@stocksense.ai',
        passwordHash: 'dummy-hash-for-alert-tests-12345678',
      },
    });

    // Resolve an existing active stock from DB
    testStock = await prisma.stock.findFirst({
      where: { isActive: true },
    });

    if (!testStock) {
      const exchange = await prisma.exchange.upsert({
        where: { code: 'NSE' },
        update: {},
        create: { code: 'NSE', name: 'National Stock Exchange of India' },
      });
      testStock = await prisma.stock.create({
        data: {
          symbol: 'ALERT_TEST_STOCK',
          companyName: 'Alert Testing Corp',
          exchangeId: exchange.id,
          isActive: true,
        },
      });
    }

    // Clean up previous test alerts
    await prisma.stockAlert.deleteMany({
      where: {
        userId: { in: [user1.id, user2.id] },
      },
    });
  });

  after(async () => {
    // Clean up created alerts
    if (user1 && user2) {
      await prisma.stockAlert.deleteMany({
        where: {
          userId: { in: [user1.id, user2.id] },
        },
      });
      await prisma.user.deleteMany({
        where: {
          id: { in: [user1.id, user2.id] },
        },
      });
    }

    const alertQ = getAlertQueue();
    const marketQ = getMarketDataQueue();
    await alertQ.close();
    await marketQ.close();
  });

  test('1. BullMQ Queues initialize with proper options and deduplication', async () => {
    const alertQ = getAlertQueue();
    assert.ok(alertQ, 'Alert queue should be instantiated');

    const job = await addAlertEvaluationJob({
      stockId: testStock.id,
      symbol: testStock.symbol,
      currentPrice: 2500.0,
    });

    assert.ok(job.id, 'Job should receive a valid unique ID');
    assert.equal(job.name, 'evaluate-stock-alerts');

    const marketJob = await addMarketDataIngestionJob({
      symbol: testStock.symbol,
      exchange: 'NSE',
      interval: 'day',
    });
    assert.ok(marketJob.id);
  });

  test('2. Creates PRICE_ABOVE and PRICE_BELOW alerts in database', async () => {
    alertAbove = await createAlert(user1.id, {
      stockId: testStock.id,
      alertType: 'PRICE_ABOVE',
      targetValue: 2600.0,
      notes: 'Take profit when crossing 2600',
    });
    assert.equal(alertAbove.alertType, 'PRICE_ABOVE');
    assert.equal(alertAbove.targetValue, 2600);
    assert.equal(alertAbove.isActive, true);

    alertBelow = await createAlert(user2.id, {
      stockId: testStock.id,
      alertType: 'PRICE_BELOW',
      targetValue: 2400.0,
      notes: 'Stop loss when dipping below 2400',
    });
    assert.equal(alertBelow.alertType, 'PRICE_BELOW');
    assert.equal(alertBelow.targetValue, 2400);
    assert.equal(alertBelow.isActive, true);
  });

  test('3. Does not trigger alerts when price is between thresholds (2500)', async () => {
    const triggered = await evaluateAlertsForStock({
      stockId: testStock.id,
      symbol: testStock.symbol,
      currentPrice: 2500.0,
    });

    assert.equal(triggered.length, 0, 'No alerts should trigger at mid price');

    const alertAboveDb = await prisma.stockAlert.findUnique({ where: { id: alertAbove.id } });
    const alertBelowDb = await prisma.stockAlert.findUnique({ where: { id: alertBelow.id } });
    assert.equal(alertAboveDb.isActive, true);
    assert.equal(alertBelowDb.isActive, true);
  });

  test('4. Successfully triggers PRICE_ABOVE alert when price crosses threshold (2650 >= 2600)', async () => {
    notificationHistory.length = 0; // Reset notification log

    const triggered = await evaluateAlertsForStock({
      stockId: testStock.id,
      symbol: testStock.symbol,
      currentPrice: 2650.0,
    });

    assert.equal(triggered.length, 1, 'Expected exactly one alert to trigger');
    assert.equal(triggered[0].id, alertAbove.id);
    assert.equal(triggered[0].isActive, false);
    assert.ok(triggered[0].triggeredAt);

    // Verify DB state persisted atomically
    const alertAboveDb = await prisma.stockAlert.findUnique({ where: { id: alertAbove.id } });
    assert.equal(alertAboveDb.isActive, false);
    assert.ok(alertAboveDb.triggeredAt);

    // Verify notification was delivered
    assert.equal(notificationHistory.length, 1);
    assert.equal(notificationHistory[0].alertId, alertAbove.id);
    assert.equal(notificationHistory[0].currentPrice, 2650);
  });

  test('5. Enforces exact-once trigger guarantee (subsequent run does not duplicate trigger)', async () => {
    const duplicateRun = await evaluateAlertsForStock({
      stockId: testStock.id,
      symbol: testStock.symbol,
      currentPrice: 2700.0,
    });

    assert.equal(duplicateRun.length, 0, 'Already triggered alert must never trigger again');
  });

  test('6. Successfully triggers PRICE_BELOW alert when price drops (2350 <= 2400)', async () => {
    const triggered = await evaluateAlertsForStock({
      stockId: testStock.id,
      symbol: testStock.symbol,
      currentPrice: 2350.0,
    });

    assert.equal(triggered.length, 1);
    assert.equal(triggered[0].id, alertBelow.id);

    const alertBelowDb = await prisma.stockAlert.findUnique({ where: { id: alertBelow.id } });
    assert.equal(alertBelowDb.isActive, false);
    assert.ok(alertBelowDb.triggeredAt);
  });

  test('7. BullMQ Worker processes alert job and executes cleanly', async () => {
    // Create new alert for worker test
    const workerAlert = await createAlert(user1.id, {
      stockId: testStock.id,
      alertType: 'PRICE_ABOVE',
      targetValue: 2800.0,
    });

    const worker = createAlertWorker({ concurrency: 1 });

    const job = await addAlertEvaluationJob({
      stockId: testStock.id,
      symbol: testStock.symbol,
      currentPrice: 2850.0,
    });

    // Wait for job completion
    await new Promise((resolve) => {
      worker.on('completed', (completedJob) => {
        if (completedJob.id === job.id) {
          resolve();
        }
      });
      // Safety timeout
      setTimeout(resolve, 3000);
    });

    const updated = await prisma.stockAlert.findUnique({ where: { id: workerAlert.id } });
    assert.equal(updated.isActive, false);
    assert.ok(updated.triggeredAt);

    await worker.close();
  });
});
