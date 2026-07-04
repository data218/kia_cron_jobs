import 'dotenv/config';
import { createGdmsAccountProfile } from '../src/accounts/gdms-account-profile.js';
import { createAmPlatinumAccount } from '../src/accounts/am-platinum-accounts.js';
import { loginToHmilDms } from '../src/auth/hmil-login.js';
import { config } from '../src/config.js';
import { changeActiveDealerForDms } from '../src/navigation/dealer-change.js';
import { downloadHyundaiRepairOrderListReport } from '../src/reports/hyundai-repair-order-list.js';
import { getCalendarMonthRanges, parseIsoLocalDate } from '../src/utils/date-range.js';
import { clearCheckpoint, readCheckpoint, writeCheckpoint } from '../src/utils/checkpoint.js';
import { isBrowserClosedError } from '../src/utils/failure.js';
import { logger } from '../src/utils/logger.js';
import { waitForConnectivity } from '../src/utils/network.js';
import { retry } from '../src/utils/retry.js';

const CHECKPOINT_NAME = 'repair-order-fix-once';

function todayIsoLocal() {
  const today = new Date();
  return [
    today.getFullYear(),
    String(today.getMonth() + 1).padStart(2, '0'),
    String(today.getDate()).padStart(2, '0')
  ].join('-');
}

function serializeError(error) {
  return {
    name: error.name,
    message: error.message,
    stack: error.stack
  };
}

function buildTasks() {
  const todayIso = todayIsoLocal();
  const hmilPrimary = createGdmsAccountProfile('hmil');
  const hmilSecondary = createGdmsAccountProfile('hmil-secondary');
  const platinumHistorical = createAmPlatinumAccount('historical');
  const platinumCurrent = createAmPlatinumAccount('current');

  const tasks = [];

  for (const range of getCalendarMonthRanges(parseIsoLocalDate('2025-01-01'), parseIsoLocalDate('2026-04-25'))) {
    tasks.push({
      scope: 'hmil',
      loginKey: 'hmil',
      account: { ...hmilPrimary, currentMonthOnly: false, repairOrderUseActiveDealerOnly: true },
      dealerCode: 'active',
      range
    });
  }

  for (const range of getCalendarMonthRanges(parseIsoLocalDate('2026-04-25'), parseIsoLocalDate(todayIso))) {
    tasks.push({
      scope: 'hmil',
      loginKey: 'hmil-secondary',
      account: { ...hmilSecondary, currentMonthOnly: false, repairOrderUseActiveDealerOnly: true },
      dealerCode: 'active',
      range
    });
  }

  for (const dealerCode of ['N5211', 'N6828']) {
    for (const range of getCalendarMonthRanges(parseIsoLocalDate('2025-01-01'), parseIsoLocalDate(todayIso))) {
      tasks.push({
        scope: 'platinum',
        loginKey: 'am-platinum-historical',
        account: { ...platinumHistorical, currentMonthOnly: false },
        dealerCode,
        range
      });
    }
  }

  for (const range of getCalendarMonthRanges(parseIsoLocalDate('2025-01-01'), parseIsoLocalDate(todayIso))) {
    tasks.push({
      scope: 'platinum',
      loginKey: 'am-platinum',
      account: { ...platinumCurrent, currentMonthOnly: false },
      dealerCode: 'N6250',
      range
    });
  }

  return tasks.map(task => ({
    ...task,
    taskKey: `${task.scope}:${task.loginKey}:${task.dealerCode}:${task.range.startIso}:${task.range.endIso}`
  }));
}

async function loginForAccount(account) {
  return retry(
    () => loginToHmilDms(account),
    {
      attempts: (account.loginRetries ?? config.loginRetries) + 1,
      delayMs: config.retryDelayMs,
      label: `${account.logPrefix} repair-order one-time login`
    }
  );
}

const tasks = buildTasks();
const checkpoint = await readCheckpoint(CHECKPOINT_NAME);
const taskKeys = tasks.map(task => task.taskKey);
const canResume = JSON.stringify(checkpoint?.taskKeys ?? []) === JSON.stringify(taskKeys)
  && Number.isInteger(checkpoint?.nextIndex)
  && checkpoint.nextIndex >= 0
  && checkpoint.nextIndex < tasks.length;
const startIndex = canResume ? checkpoint.nextIndex : 0;

logger.info('Starting one-time repair-order fix run', {
  taskCount: tasks.length,
  resumed: canResume,
  startIndex
});

await waitForConnectivity({ label: 'repair-order-fix-once startup' });

let session = null;
let activeLoginKey = null;
let activeDealerCode = null;

try {
  for (let index = startIndex; index < tasks.length; index += 1) {
    const task = tasks[index];
    await writeCheckpoint(CHECKPOINT_NAME, {
      nextIndex: index,
      taskKeys,
      task: {
        loginKey: task.loginKey,
        dealerCode: task.dealerCode,
        startIso: task.range.startIso,
        endIso: task.range.endIso
      }
    });

    if (activeLoginKey !== task.loginKey) {
      await session?.close?.().catch(() => {});
      session = await loginForAccount(task.account);
      activeLoginKey = task.loginKey;
      activeDealerCode = 'active';
    }

    if (!task.account.repairOrderUseActiveDealerOnly && task.dealerCode !== 'active' && activeDealerCode !== task.dealerCode) {
      await changeActiveDealerForDms(session.page, task.dealerCode, {
        homeUrl: task.account.homeUrl,
        systemLabel: task.account.systemLabel
      });
      activeDealerCode = task.dealerCode;
    }

    logger.info('Running repair-order task', {
      index: index + 1,
      total: tasks.length,
      loginKey: task.loginKey,
      dealerCode: task.dealerCode,
      range: `${task.range.startIso} to ${task.range.endIso}`
    });

    await downloadHyundaiRepairOrderListReport(session.page, {
      account: task.account,
      dealerCode: task.dealerCode,
      range: task.range,
      skipNavigation: false
    });

    if (index + 1 < tasks.length) {
      await writeCheckpoint(CHECKPOINT_NAME, {
        nextIndex: index + 1,
        taskKeys
      });
    } else {
      await clearCheckpoint(CHECKPOINT_NAME);
    }
  }

  await clearCheckpoint(CHECKPOINT_NAME);
  logger.info('One-time repair-order fix run completed successfully', {
    taskCount: tasks.length
  });
} catch (error) {
  logger.error('One-time repair-order fix run failed', {
    err: serializeError(error),
    browserClosed: isBrowserClosedError(error)
  });
  throw error;
} finally {
  await session?.close?.().catch(() => {});
}
