import { parentPort, workerData } from 'worker_threads';
import { ChatParser } from './chatParser';
import { parseElsoMessage, formatLootDiaryContent } from './itemAcquisition';
import { decodeChatLogBuffer, normalizeChatLogLines } from './chatLogNormalizer';
import type { SyncTargetFile } from './chatLogSyncManager';
import { readChatLogFileWithRetry } from './chatLogFileRetry';

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
  targetFiles: SyncTargetFile[];
  lootKeywords: string[];
}

export interface ParsedLoot {
  date: string;
  timeOnly: string;
  diaryContent: string;
  count: number;
}

export interface ParsedShout {
  fullTimestamp: number;
  sender: string;
  message: string;
}

export interface ParsedSeed {
  date: string;
  timeOnly: string;
  content: string;
  amount: number;
}

export interface ParsedElso {
  date: string;
  timeOnly: string;
  amount: number;
}

export interface WorkerDoneData {
  totalLines: number;
  loots: ParsedLoot[];
  essences: ParsedLoot[];
  shouts: ParsedShout[];
  seeds: ParsedSeed[];
  elsoPoints: ParsedElso[];
  accumulatedHomework: Record<string, number>;
  failedFiles: Array<{ fileName: string; date: string; error: string }>;
}

async function runWorker() {
  if (!parentPort) return;

  const data = workerData as WorkerInputData;
  const { targetFiles, lootKeywords } = data;

  const loots: ParsedLoot[] = [];
  const essences: ParsedLoot[] = [];
  const shouts: ParsedShout[] = [];
  const seeds: ParsedSeed[] = [];
  const elsoPoints: ParsedElso[] = [];
  const accumulatedHomework: Record<string, number> = {};
  const failedFiles: Array<{ fileName: string; date: string; error: string }> = [];

  let totalLines = 0;

  const syncParser = new ChatParser();

  const recordHomework = (id: string, count: number, isIncrement: boolean) => {
    if (isIncrement) {
      accumulatedHomework[id] = (accumulatedHomework[id] || 0) + count;
    } else {
      accumulatedHomework[id] = Math.max(accumulatedHomework[id] || 0, count);
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
    const timeOnly = evt.timestamp.replace(/ /g, '').replace(/[시분]/g, ':').replace('초', '');
    const content = `[자동] ${evt.message} (${formatKoreanNumber(evt.amount)})`;
    seeds.push({
      date: evt.date,
      timeOnly,
      content,
      amount: evt.amount
    });
  });

  // 파서 이벤트 리스너 등록
  syncParser.on('ITEM_LOOTED', (evt) => {
    try {
      const elso = parseElsoMessage(evt.message);
      if (elso > 0) {
        const timeOnly = evt.timestamp.replace(/ /g, '').replace(/[시분]/g, ':').replace('초', '');
        elsoPoints.push({
          date: evt.date,
          timeOnly,
          amount: elso
        });
      }
    } catch {
      // ignore
    }

    const matchedKeyword = lootKeywords.find(k => evt.message.includes(k));
    const isAlwaysTrackedItem = evt.itemName === '경험의 정수';
    const isMagicStone = evt.itemName.includes('마정석') || evt.message.includes('마정석');

    if (evt.isOwn && !isMagicStone) {
      const timeOnly = evt.timestamp.replace(/ /g, '').replace(/[시분]/g, ':').replace('초', '');
      if (isAlwaysTrackedItem) {
        essences.push({
          date: evt.date,
          timeOnly,
          diaryContent: formatLootDiaryContent('경험의 정수'),
          count: evt.count
        });
      } else if (matchedKeyword) {
        loots.push({
          date: evt.date,
          timeOnly,
          diaryContent: `[득템] ${evt.message}`,
          count: evt.count
        });
      }
    }
  });

  syncParser.on('MAGIC_STONE_GAIN', (evt) => {
    const timeOnly = evt.timestamp.replace(/ /g, '').replace(/[시분]/g, ':').replace('초', '');
    const grade = evt.grade.trim();
    loots.push({
      date: evt.date,
      timeOnly,
      diaryContent: `[득템] [${grade} 마정석]`,
      count: evt.count
    });
  });

  syncParser.on('XP_CHANGED', (evt) => {
    if (evt.amount <= -9_000_000_000) {
      const essenceCount = Math.round(Math.abs(evt.amount) / 10_000_000_000);
      if (essenceCount > 0) {
        const timeOnly = evt.timestamp.replace(/ /g, '').replace(/[시분]/g, ':').replace('초', '');
        essences.push({
          date: evt.date,
          timeOnly,
          diaryContent: formatLootDiaryContent('경험의 정수'),
          count: essenceCount
        });
      }
    }
  });

  const nowUnix = Math.floor(Date.now() / 1000);
  const oneDayAgo = nowUnix - (24 * 60 * 60);

  syncParser.on('TRADE_SHOUT', (evt) => {
    try {
      const timeSeconds = parseTimeToSeconds(evt.timestamp);
      const [year, month, day] = evt.date.split('-').map(Number);
      const dateObj = new Date(year, month - 1, day);
      const baseUnix = Math.floor(dateObj.getTime() / 1000);
      const fullTimestamp = baseUnix + timeSeconds;

      // 외치기 히스토리는 최근 24시간만 보관하므로 24시간 이내 데이터만 수집/동기화
      if (fullTimestamp >= oneDayAgo) {
        shouts.push({
          fullTimestamp,
          sender: evt.sender,
          message: evt.message
        });
      }
    } catch {
      // ignore
    }
  });

  // 순차 파싱
  for (let fileIdx = 0; fileIdx < targetFiles.length; fileIdx++) {
    const file = targetFiles[fileIdx];
    try {
      syncParser.setCurrentDate(file.dateStr);
      const buffer = await readChatLogFileWithRetry(file.filePath);
      const decoded = decodeChatLogBuffer(buffer);
      const lines = normalizeChatLogLines(decoded.content.split('\n'));
      const fileTotalLines = lines.length;

      for (let i = 0; i < Math.min(fileTotalLines, 25); i++) {
        if (lines[i].includes('Date :')) {
          syncParser.parseLine(lines[i]);
          break;
        }
      }

      for (let lineIdx = 0; lineIdx < fileTotalLines; lineIdx++) {
        const line = lines[lineIdx];
        if (line && !line.includes('회복되었습니다')) {
          syncParser.parseLine(line);
        }
        totalLines++;

        // 1000줄마다 진행률 전송
        if (lineIdx % 1000 === 0) {
          const lineProgress = fileTotalLines > 0 ? (lineIdx / fileTotalLines) : 0;
          const currentPercent = Math.min(99, Math.round(((fileIdx + lineProgress) / targetFiles.length) * 100));
          parentPort.postMessage({
            type: 'progress',
            data: {
              currentFile: file.fileName,
              currentFileIndex: fileIdx + 1,
              totalFiles: targetFiles.length,
              percent: currentPercent,
              date: file.dateStr,
              processedLines: totalLines,
              lootsAdded: loots.length,
              shoutsAdded: shouts.length,
              homeworkUpdated: Object.keys(accumulatedHomework).length,
              seedsAdded: seeds.length,
              elsoPointsAdded: elsoPoints.length
            }
          });
        }
      }

      const percent = Math.round(((fileIdx + 1) / targetFiles.length) * 100);
      parentPort.postMessage({
        type: 'progress',
        data: {
          currentFile: file.fileName,
          currentFileIndex: fileIdx + 1,
          totalFiles: targetFiles.length,
          percent,
          date: file.dateStr,
          processedLines: totalLines,
          lootsAdded: loots.length,
          shoutsAdded: shouts.length,
          homeworkUpdated: Object.keys(accumulatedHomework).length,
          seedsAdded: seeds.length,
          elsoPointsAdded: elsoPoints.length
        }
      });
    } catch (error) {
      failedFiles.push({
        fileName: file.fileName,
        date: file.dateStr,
        error: String(error),
      });
    }
  }

  // 완료 전송
  parentPort.postMessage({
    type: 'done',
    data: {
      totalLines,
      loots,
      essences,
      shouts,
      seeds,
      elsoPoints,
      accumulatedHomework,
      failedFiles,
    }
  });
}

runWorker().catch(err => {
  if (parentPort) {
    parentPort.postMessage({
      type: 'error',
      error: String(err)
    });
  }
});
