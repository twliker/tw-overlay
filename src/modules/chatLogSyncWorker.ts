import { promises as fsp } from 'fs';
import * as iconv from 'iconv-lite';
import { parentPort, workerData } from 'worker_threads';
import { ChatParser } from './chatParser';
import { parseElsoMessage, formatLootDiaryContent, getGoldPouchSeedAmount } from './itemAcquisition';
import { ChatLogLineNormalizer } from './chatLogNormalizer';
import { getChatLogReadRetryDelayMs, isRetryableChatLogReadError } from './chatLogFileRetry';
import {
  CHAT_SYNC_BATCH_EVENT_LIMIT,
  CHAT_SYNC_BATCH_LINE_LIMIT,
  CHAT_SYNC_READ_CHUNK_BYTES,
  createStableChatSyncEventId,
  type ChatLogFileAggregate,
  type ChatLogSyncBatchAck,
  type ChatLogSyncBatchData,
  type ParsedLootEvent,
  type ParsedSeedEvent,
  type ParsedShoutEvent,
  type WorkerSyncTargetFile,
} from './chatLogSyncProtocol';

function parseTimeToSeconds(timeStr: string): number {
  const match = timeStr.match(/(\d+)시\s*(\d+)분\s*(\d+)초/);
  if (!match) return 0;
  const h = parseInt(match[1], 10);
  const m = parseInt(match[2], 10);
  const s = parseInt(match[3], 10);
  return h * 3600 + m * 60 + s;
}

function formatKoreanNumber(val: number): string {
  if (val >= 100000000) {
    const eok = Math.floor(val / 100000000);
    const man = Math.floor((val % 100000000) / 10000);
    return man > 0 ? `${eok}억 ${man}만` : `${eok}억`;
  }
  if (val >= 10000) {
    return `${Math.floor(val / 10000)}만`;
  }
  return val.toLocaleString();
}

interface WorkerInputData {
  jobId: string;
  targetFiles: WorkerSyncTargetFile[];
  lootKeywords: string[];
}

const wait = (delayMs: number) => new Promise(resolve => setTimeout(resolve, delayMs));

async function openChatLogWithRetry(filePath: string): Promise<fsp.FileHandle> {
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      return await fsp.open(filePath, 'r');
    } catch (error) {
      if (!isRetryableChatLogReadError(error) || attempt === 4) throw error;
      await wait(getChatLogReadRetryDelayMs(attempt));
    }
  }
  throw new Error('채팅 로그 열기 재시도 상태가 올바르지 않습니다.');
}

async function runWorker() {
  if (!parentPort) return;
  const port = parentPort;

  const data = workerData as WorkerInputData;
  const { jobId, targetFiles, lootKeywords } = data;

  let currentFile: WorkerSyncTargetFile | null = null;
  let aggregate: ChatLogFileAggregate | null = null;
  let loots: ParsedLootEvent[] = [];
  let essences: ParsedLootEvent[] = [];
  let shouts: ParsedShoutEvent[] = [];
  let seeds: ParsedSeedEvent[] = [];
  let currentEventOffset = 0;
  let currentEventSequence = 0;
  const failedFiles: Array<{ fileName: string; date: string; error: string }> = [];

  const syncParser = new ChatParser();

  const nextEventId = (kind: string): string => {
    if (!currentFile) throw new Error('현재 채팅 로그 파일이 없습니다.');
    return createStableChatSyncEventId(
      currentFile.fingerprint,
      currentEventOffset,
      kind,
      currentEventSequence++,
    );
  };

  const recordHomework = (id: string, count: number, isIncrement: boolean) => {
    if (!aggregate) return;
    const existing = aggregate.homework[id];
    if (!existing) {
      aggregate.homework[id] = { count, isIncrement };
      return;
    }
    if (isIncrement) {
      aggregate.homework[id] = {
        count: existing.count + count,
        isIncrement: existing.isIncrement,
      };
    } else {
      aggregate.homework[id] = {
        count: Math.max(existing.count, count),
        isIncrement: false,
      };
    }
  };

  syncParser.on('ETERNAL_FLOOR_CLEAR', () => {
    recordHomework('weekly-eternal-floor', 1, true);
  });

  syncParser.on('ECLIPSE_BOSS_CLEAR', (evt) => {
    const bossMapping: Record<string, string> = {
      '에토스': 'weekly-eclipse-boss-ethos',
      '마티아': 'weekly-eclipse-boss-matias',
      '티로로스': 'weekly-eclipse-boss-tyrorost',
      '라이코스': 'weekly-eclipse-boss-lycos',
      '체리아': 'weekly-eclipse-boss-cheria',
      '로카고스': 'weekly-eclipse-boss-lokagos'
    };
    const id = bossMapping[evt.bossName];
    if (id) recordHomework(id, evt.count, false);
  });

  syncParser.on('MERCURIAL_BOSS_CLEAR', (evt) => {
    const bossMapping: Record<string, string> = {
      '실반': 'weekly-mur-sylvan',
      '샐리온': 'weekly-mur-salion',
      '실라이론': 'weekly-mur-silyron',
      '샐레아나': 'weekly-mur-saleana',
      '루미너스': 'weekly-mur-luminous',
      '루미너스 (EX)': 'weekly-mur-luminous-ex',
      '루미너스(EX)': 'weekly-mur-luminous-ex'
    };
    const id = bossMapping[evt.bossName];
    if (id) recordHomework(id, evt.count, false);
  });

  syncParser.on('CORE_MASTER_CLEAR', (evt) => {
    const coreMapping: Record<string, string> = {
      '심층Ⅰ': 'weekly-abyss-core-master-1',
      '심층Ⅱ': 'weekly-abyss-core-master-2',
      '심층ⅠⅠ': 'weekly-abyss-core-master-2',
      '심층Ⅲ': 'weekly-abyss-core-master-3',
      '실반': 'weekly-mur-core-master-sylvan',
      '샐리온': 'weekly-mur-core-master-salion',
      '실라이론': 'weekly-mur-core-master-silyron',
      '샐레아나': 'weekly-mur-core-master-saleana',
      '루미너스': 'weekly-mur-core-master-luminous'
    };
    const id = coreMapping[evt.contentName];
    if (id) recordHomework(id, evt.count, evt.isIncrement !== false);
  });

  syncParser.on('RELIC_SANCTUARY_CLEAR', (evt) => {
    recordHomework('weekly-ancient-relic', evt.count, false);
  });

  syncParser.on('POWER_ROOT_CLEAR', (evt) => {
    recordHomework('weekly-power-root', evt.count, false);
  });

  syncParser.on('ABYSS_TREASURE_ENTRY', (evt) => {
    recordHomework('weekly-abyss-treasure', evt.count, false);
  });

  syncParser.on('ECLIPSE_SUPPLIES_CLEAR', (evt) => {
    recordHomework('weekly-eclipse-recapture-supplies', evt.count, false);
  });

  syncParser.on('ECLIPSE_SPECIAL_FORCE_CLEAR', (evt) => {
    recordHomework('weekly-eclipse-special-force-suppression', evt.count, false);
  });

  syncParser.on('FORTRESS_GHOST_CLEAR', (evt) => {
    recordHomework('weekly-fortress-ghost', evt.count, false);
  });

  syncParser.on('TESIS_CORE_CLEAR', () => {
    recordHomework('weekly-tesis-core', 1, true);
  });

  syncParser.on('DIGSITE_ENTRY', (evt) => {
    if (typeof evt.count === 'number') {
      recordHomework('weekly-digsite', evt.count, false);
    } else {
      recordHomework('weekly-digsite', 1, true);
    }
  });

  syncParser.on('CONTENT_SHINJO_NEST_CLEAR', (evt) => {
    recordHomework('weekly-shinjo-nest', evt.count, false);
  });

  syncParser.on('ABYSS_DUNGEON_CLEAR', (evt) => {
    const depthMap: Record<string, string> = {
      '심층Ⅰ': 'weekly-abyss-dungeon-1',
      '심층Ⅱ': 'weekly-abyss-dungeon-2',
      '심층Ⅲ': 'weekly-abyss-dungeon-3'
    };
    const id = depthMap[evt.depth];
    if (id) recordHomework(id, evt.count, false);
  });

  syncParser.on('ABYSS_BOSS_EX_CLEAR', (evt) => {
    recordHomework('weekly-abyss-boss-ex', evt.count, false);
  });

  syncParser.on('SIOKAN_BOSS_CLEAR', (evt) => {
    recordHomework('weekly-siokan-boss', evt.count, false);
  });

  syncParser.on('SIOKAN_ODIN_CLEAR', (evt) => {
    recordHomework('weekly-siokan-odin', evt.count, false);
  });

  syncParser.on('ECLIPSE_BOSS_SUBJUGATION_CLEAR', (evt) => {
    recordHomework('weekly-eclipse-boss', evt.count, false);
  });

  syncParser.on('MOON_QUEEN_TRAINING_CLEAR', (evt) => {
    recordHomework('weekly-moon-queen', evt.count, false);
  });

  syncParser.on('APETHIRIA_RAID_CLEAR', (evt) => {
    recordHomework('weekly-apethiria-raid', evt.count, false);
  });

  syncParser.on('PRAVA_DEFENSE_CLEAR', () => {
    recordHomework('weekly-prava-defense', 1, true);
  });

  syncParser.on('ORLY_DEFENSE_CLEAR', () => {
    recordHomework('weekly-orly-defense', 1, true);
  });

  syncParser.on('CATACOMB_CLEAR', () => {
    recordHomework('weekly-catacomb-hell', 1, true);
  });

  syncParser.on('VESTIGE_CLEAR', () => {
    recordHomework('weekly-vestige', 1, true);
  });

  syncParser.on('THURSDAY_CLEAN_CLEAR', () => {
    recordHomework('weekly-thursday-clean', 1, true);
  });

  syncParser.on('ETA_DAILY_BOX_GAIN', () => {
    recordHomework('daily-eta-quest', 1, true);
  });

  syncParser.on('ETA_WILL_UPGRADE_GAIN', () => {
    recordHomework('daily-eta-will-upgrade', 1, true);
  });

  syncParser.on('CLUB_POINT_500_GAIN', () => {
    recordHomework('daily-club-boss', 1, true);
  });

  syncParser.on('CONFUSED_LAND_CLEAR', () => {
    recordHomework('daily-confused-land', 1, true);
  });

  syncParser.on('COLORLESS_LAND_CLEAR', () => {
    recordHomework('daily-colorless-land', 1, true);
  });

  syncParser.on('ARCHITECT_MINE_ENTRY', () => {
    recordHomework('daily-architect-mine', 1, true);
  });

  syncParser.on('ABANDONED_ENTRY', (evt) => {
    const regionMapping: Record<string, string> = {
      '필멸의 땅': 'weekly-abandon-road-mortal',
      '카디프': 'weekly-abandon-road-cardiff',
      '오를란느': 'weekly-abandon-road-orlanne'
    };
    const id = regionMapping[evt.region];
    if (id) recordHomework(id, evt.count, false);
  });

  syncParser.on('PITTA_ENTRY', (evt) => {
    const energy = typeof evt.energy === 'number' && !isNaN(evt.energy) ? evt.energy : 0;
    const computedCount = (20 - energy) + 1;
    if (computedCount >= 1 && computedCount <= 5) {
      recordHomework('daily-pitta', computedCount, false);
    }
  });

  syncParser.on('SEED_GAINED', (evt) => {
    if (!aggregate) return;
    const timeOnly = evt.timestamp.replace(/ /g, '').replace(/[시분]/g, ':').replace('초', '');
    const content = `[자동] ${evt.message} (${formatKoreanNumber(evt.amount)})`;
    seeds.push({
      eventId: nextEventId('seed'),
      date: evt.date,
      timeOnly,
      content,
      amount: evt.amount
    });
    aggregate.seedsDetected++;
  });

  // 파서 이벤트 리스너 등록
  syncParser.on('ITEM_LOOTED', (evt) => {
    if (!aggregate) return;
    try {
      const elso = parseElsoMessage(evt.message);
      if (elso > 0) {
        const timeOnly = evt.timestamp.replace(/ /g, '').replace(/[시분]/g, ':').replace('초', '');
        const existing = aggregate.elsoByDate[evt.date];
        aggregate.elsoByDate[evt.date] = {
          latestTime: timeOnly,
          totalAmount: (existing?.totalAmount || 0) + elso,
        };
        aggregate.elsoPointsDetected += elso;
      }
    } catch {
      // ignore
    }

    const goldPouchSeed = getGoldPouchSeedAmount(evt);
    if (goldPouchSeed > 0) {
      const timeOnly = evt.timestamp.replace(/ /g, '').replace(/[시분]/g, ':').replace('초', '');
      const existing = aggregate.goldPouchSeedByDate[evt.date];
      aggregate.goldPouchSeedByDate[evt.date] = {
        latestTime: timeOnly,
        totalAmount: (existing?.totalAmount || 0) + goldPouchSeed,
      };
      aggregate.seedsDetected++;
    }

    const matchedKeyword = lootKeywords.find(k => evt.message.includes(k));
    const isAlwaysTrackedItem = evt.itemName === '경험의 정수';
    const isMagicStone = evt.itemName.includes('마정석') || evt.message.includes('마정석');

    if (evt.isOwn && !isMagicStone) {
      const timeOnly = evt.timestamp.replace(/ /g, '').replace(/[시분]/g, ':').replace('초', '');
      if (isAlwaysTrackedItem) {
        essences.push({
          eventId: nextEventId('essence'),
          date: evt.date,
          timeOnly,
          diaryContent: formatLootDiaryContent('경험의 정수'),
          count: evt.count
        });
        aggregate.essencesDetected += evt.count;
      } else if (matchedKeyword) {
        loots.push({
          eventId: nextEventId('loot'),
          date: evt.date,
          timeOnly,
          diaryContent: `[득템] ${evt.message}`,
          count: evt.count
        });
        aggregate.lootsDetected++;
      }
    }
  });

  syncParser.on('MAGIC_STONE_GAIN', (evt) => {
    if (!aggregate) return;
    const timeOnly = evt.timestamp.replace(/ /g, '').replace(/[시분]/g, ':').replace('초', '');
    const grade = evt.grade.trim();
    if (!aggregate.magicStones[evt.date]) aggregate.magicStones[evt.date] = {};
    const existing = aggregate.magicStones[evt.date][grade];
    aggregate.magicStones[evt.date][grade] = {
      latestTime: timeOnly,
      totalCount: (existing?.totalCount || 0) + evt.count,
    };
    aggregate.lootsDetected++;
  });

  syncParser.on('XP_CHANGED', (evt) => {
    if (!aggregate) return;
    if (evt.amount <= -9_000_000_000) {
      const essenceCount = Math.round(Math.abs(evt.amount) / 10_000_000_000);
      if (essenceCount > 0) {
        const timeOnly = evt.timestamp.replace(/ /g, '').replace(/[시분]/g, ':').replace('초', '');
        essences.push({
          eventId: nextEventId('essence-xp'),
          date: evt.date,
          timeOnly,
          diaryContent: formatLootDiaryContent('경험의 정수'),
          count: essenceCount
        });
        aggregate.essencesDetected += essenceCount;
      }
    }
  });

  const nowUnix = Math.floor(Date.now() / 1000);
  const oneDayAgo = nowUnix - (24 * 60 * 60);

  syncParser.on('TRADE_SHOUT', (evt) => {
    if (!aggregate) return;
    try {
      const timeSeconds = parseTimeToSeconds(evt.timestamp);
      const [year, month, day] = evt.date.split('-').map(Number);
      const dateObj = new Date(year, month - 1, day);
      const baseUnix = Math.floor(dateObj.getTime() / 1000);
      const fullTimestamp = baseUnix + timeSeconds;

      // 외치기 히스토리는 최근 24시간만 보관하므로 24시간 이내 데이터만 수집/동기화
      if (fullTimestamp >= oneDayAgo) {
        shouts.push({
          eventId: nextEventId('shout'),
          fullTimestamp,
          sender: evt.sender,
          message: evt.message
        });
        aggregate.shoutsDetected++;
      }
    } catch {
      // ignore
    }
  });

  const pendingAcks = new Map<string, {
    resolve: () => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
  }>();
  port.on('message', (message: ChatLogSyncBatchAck) => {
    if (message?.type !== 'batch-ack' || message.jobId !== jobId) return;
    const pending = pendingAcks.get(message.batchId);
    if (!pending) return;
    pendingAcks.delete(message.batchId);
    clearTimeout(pending.timeout);
    if (message.success) pending.resolve();
    else pending.reject(new Error(message.error || '메인 프로세스가 채팅 로그 배치를 거부했습니다.'));
  });

  const postBatchAndWaitForAck = async (batch: ChatLogSyncBatchData): Promise<void> => {
    const acknowledged = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        pendingAcks.delete(batch.batchId);
        reject(new Error(`채팅 로그 배치 ACK 시간 초과: ${batch.batchId}`));
      }, 30_000);
      pendingAcks.set(batch.batchId, { resolve, reject, timeout });
    });
    port.postMessage({ type: 'batch', data: batch });
    await acknowledged;
  };

  let batchSequence = 0;
  for (let fileIdx = 0; fileIdx < targetFiles.length; fileIdx++) {
    const file = targetFiles[fileIdx];
    currentFile = file;
    aggregate = structuredClone(file.aggregate);
    loots = [];
    essences = [];
    shouts = [];
    seeds = [];
    let linesSinceBatch = 0;
    let confirmedOffset = file.startOffset;

    const sendProgress = (offset: number, completed: boolean): void => {
      const fileProgress = file.snapshotSize > 0 ? Math.min(1, offset / file.snapshotSize) : 1;
      const percent = completed
        ? Math.round(((fileIdx + 1) / targetFiles.length) * 100)
        : Math.min(99, Math.round(((fileIdx + fileProgress) / targetFiles.length) * 100));
      port.postMessage({
        type: 'progress',
        data: {
          currentFile: file.fileName,
          currentFileIndex: fileIdx + 1,
          totalFiles: targetFiles.length,
          percent,
          date: file.dateStr,
          processedLines: aggregate?.totalLines || 0,
          lootsAdded: aggregate?.lootsDetected || 0,
          shoutsAdded: aggregate?.shoutsDetected || 0,
          homeworkUpdated: Object.keys(aggregate?.homework || {}).length,
          seedsAdded: aggregate?.seedsDetected || 0,
          elsoPointsAdded: aggregate?.elsoPointsDetected || 0,
        }
      });
    };

    const sendBatch = async (offset: number, fileComplete: boolean): Promise<void> => {
      if (!aggregate) throw new Error('채팅 로그 파일 누적 상태가 없습니다.');
      const aggregateLoots: ParsedLootEvent[] = [];
      const aggregateElso = [] as ChatLogSyncBatchData['elsoPoints'];
      const aggregateGoldPouchSeeds: NonNullable<ChatLogSyncBatchData['goldPouchSeeds']> = [];
      if (fileComplete) {
        for (const [date, grades] of Object.entries(aggregate.magicStones)) {
          for (const [grade, info] of Object.entries(grades)) {
            aggregateLoots.push({
              date,
              timeOnly: info.latestTime,
              diaryContent: `[득템] [${grade} 마정석]`,
              count: info.totalCount,
            });
          }
        }
        for (const [date, info] of Object.entries(aggregate.elsoByDate)) {
          aggregateElso.push({ date, timeOnly: info.latestTime, amount: info.totalAmount });
        }
        for (const [date, info] of Object.entries(aggregate.goldPouchSeedByDate)) {
          aggregateGoldPouchSeeds.push({ date, timeOnly: info.latestTime, amount: info.totalAmount });
        }
      }
      const batch: ChatLogSyncBatchData = {
        jobId,
        batchId: `${jobId}:${fileIdx}:${batchSequence++}`,
        filePath: file.filePath,
        fileName: file.fileName,
        dateStr: file.dateStr,
        fingerprint: file.fingerprint,
        fingerprintBytes: file.fingerprintBytes,
        confirmedOffset: offset,
        snapshotSize: file.snapshotSize,
        fileComplete,
        aggregate: structuredClone(aggregate),
        loots: [...loots, ...aggregateLoots],
        essences: [...essences],
        shouts: [...shouts],
        seeds: [...seeds],
        elsoPoints: aggregateElso,
        goldPouchSeeds: aggregateGoldPouchSeeds,
      };
      await postBatchAndWaitForAck(batch);
      loots = [];
      essences = [];
      shouts = [];
      seeds = [];
      linesSinceBatch = 0;
      confirmedOffset = offset;
    };

    try {
      syncParser.setCurrentDate(file.dateStr);
      const normalizer = new ChatLogLineNormalizer();
      let pendingStartOffset: number | null = null;
      let carry = Buffer.alloc(0);
      let carryStartOffset = file.startOffset;

      const parseNormalizedLine = (line: string, eventOffset: number): void => {
        currentEventOffset = eventOffset;
        currentEventSequence = 0;
        if (line && !line.includes('회복되었습니다')) syncParser.parseLine(line);
      };

      const processRawLine = (rawLine: Buffer, lineStart: number, lineEnd: number): void => {
        if (!aggregate) return;
        let decodedLine = iconv.decode(rawLine, file.encoding);
        if (decodedLine.endsWith('\r')) decodedLine = decodedLine.slice(0, -1);
        const hadPending = normalizer.hasPending();
        const previousPendingStart = pendingStartOffset;
        const output = normalizer.push(decodedLine);

        if (!hadPending) {
          output.forEach(line => parseNormalizedLine(line, lineStart));
        } else if (output.length >= 2) {
          parseNormalizedLine(output[0], previousPendingStart ?? lineStart);
          output.slice(1).forEach(line => parseNormalizedLine(line, lineStart));
        } else if (output.length === 1) {
          parseNormalizedLine(output[0], previousPendingStart ?? lineStart);
        }

        if (normalizer.hasPending()) {
          if (!hadPending || output.length > 0) pendingStartOffset = lineStart;
        } else {
          pendingStartOffset = null;
        }
        aggregate.totalLines++;
        linesSinceBatch++;
        confirmedOffset = normalizer.hasPending() ? (pendingStartOffset ?? lineStart) : lineEnd;
      };

      const handle = await openChatLogWithRetry(file.filePath);
      try {
        let readPosition = file.startOffset;
        while (readPosition < file.snapshotSize) {
          const readLength = Math.min(CHAT_SYNC_READ_CHUNK_BYTES, file.snapshotSize - readPosition);
          const readBuffer = Buffer.allocUnsafe(readLength);
          const { bytesRead } = await handle.read(readBuffer, 0, readLength, readPosition);
          if (bytesRead === 0) break;
          const bytes = readBuffer.subarray(0, bytesRead);
          const combinedStart = carry.length > 0 ? carryStartOffset : readPosition;
          const combined = carry.length > 0 ? Buffer.concat([carry, bytes]) : bytes;
          let lineStartInBuffer = 0;
          for (let index = 0; index < combined.length; index++) {
            if (combined[index] !== 0x0a) continue;
            const absoluteStart = combinedStart + lineStartInBuffer;
            const absoluteEnd = combinedStart + index + 1;
            processRawLine(combined.subarray(lineStartInBuffer, index), absoluteStart, absoluteEnd);
            lineStartInBuffer = index + 1;

            const bufferedEventCount = loots.length + essences.length + shouts.length + seeds.length;
            if (!normalizer.hasPending()
              && (linesSinceBatch >= CHAT_SYNC_BATCH_LINE_LIMIT
                || bufferedEventCount >= CHAT_SYNC_BATCH_EVENT_LIMIT)) {
              await sendBatch(confirmedOffset, false);
              sendProgress(confirmedOffset, false);
            }
          }
          carry = combined.subarray(lineStartInBuffer);
          carryStartOffset = combinedStart + lineStartInBuffer;
          readPosition += bytesRead;
        }

        let incompleteTrailingLine = false;
        if (carry.length > 0) {
          const trailingText = iconv.decode(carry, file.encoding).trimEnd();
          if (/<\/br>\s*$/i.test(trailingText)) {
            processRawLine(carry, carryStartOffset, file.snapshotSize);
            carry = Buffer.alloc(0);
          } else {
            incompleteTrailingLine = true;
          }
        }

        if (!incompleteTrailingLine) {
          const pending = normalizer.flush();
          pending.forEach(line => parseNormalizedLine(line, pendingStartOffset ?? confirmedOffset));
          pendingStartOffset = null;
          confirmedOffset = file.snapshotSize;
        }
      } finally {
        await handle.close();
      }

      const fileComplete = confirmedOffset === file.snapshotSize;
      await sendBatch(confirmedOffset, fileComplete);
      sendProgress(confirmedOffset, true);
    } catch (error) {
      failedFiles.push({
        fileName: file.fileName,
        date: file.dateStr,
        error: String(error),
      });
    }
  }

  port.postMessage({
    type: 'done',
    data: { jobId, failedFiles }
  });
  port.close();
}

runWorker().catch(err => {
  if (parentPort) {
    parentPort.postMessage({
      type: 'error',
      error: String(err)
    });
  }
});
