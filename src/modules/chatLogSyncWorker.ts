import { promises as fsp } from 'fs';
import * as iconv from 'iconv-lite';
import { parentPort, workerData } from 'worker_threads';
import { ChatParser } from './chatParser';
import type {ChatParserEventMap} from '../shared/types';
import { parseElsoMessage, formatLootDiaryContent, getGoldPouchSeedAmount } from './itemAcquisition';
import { isAlwaysTrackedLoot, matchesRegisteredLoot } from '../shared/lootPolicy';
import { getEssenceExchangeCount } from '../shared/experienceEssence';
import { getHomeworkResetCycleKey } from '../shared/homeworkResetCycle';
import { ChatLogLineNormalizer } from './chatLogNormalizer';
import { getChatLogReadRetryDelayMs, isRetryableChatLogReadError } from './chatLogFileRetry';
import {
  CHAT_SYNC_BATCH_EVENT_LIMIT,
  CHAT_SYNC_BATCH_LINE_LIMIT,
  CHAT_SYNC_READ_CHUNK_BYTES,
  createStableChatSyncEventId,
  createChatLogLineKey,
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
  homeworkCycleKeys: Record<string, {
    rule: { type: 'daily' | 'weekly'; hour: number; dayOfWeek?: number };
    cycleKey: string;
    maxCount: number;
    name: string;
    category: string;
    isVisible: boolean;
    replayExclusions?:Array<{start:number;end:number}>;
  }>;
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
  const { jobId, targetFiles, lootKeywords, homeworkCycleKeys = {} } = data;

  let currentFile: WorkerSyncTargetFile | null = null;
  let aggregate: ChatLogFileAggregate | null = null;
  let loots: ParsedLootEvent[] = [];
  let essences: ParsedLootEvent[] = [];
  let shouts: ParsedShoutEvent[] = [];
  let seeds: ParsedSeedEvent[] = [];
  let currentEventOffset = 0;
  let currentEventSequence = 0;
  let currentEventTimestamp = 0;
  let currentLine = '';
  let currentLineKey: string | undefined;
  let currentEventNew = false;
  let repairOnly = false;
  let legacyOwnsCurrentLine = false;
  let appliedCurrentLine = false;
  /** 프로필 복원의 처리 구간: 이 프로필이 처리한 줄의 이어진 byte 구간. 제외·다른 소유 줄에서 끊는다. */
  let foreignLine = false;
  let spanStart = 0;
  let lastLineStart: number | undefined;
  let ownedSpans: Array<{start:number;end:number}> = [];
  const closeForeignLine = (): void => {
    if (lastLineStart === undefined || !foreignLine) return;
    if (lastLineStart > spanStart) ownedSpans.push({start:spanStart,end:lastLineStart});
  };
  const lineKeys = new Set<string>();
  let elsoEvents: ChatLogSyncBatchData['elsoPoints'] = [];
  let goldEvents: NonNullable<ChatLogSyncBatchData['goldPouchSeeds']> = [];
  const failedFiles: Array<{ fileName: string; date: string; error: string }> = [];

  const syncParser = new ChatParser();
  // 이미 다른 프로필/미배정에 귀속된 원본 구간은 소유 기록을 다시 만들지 않는다.
  // 외치기는 공통이므로 전체 snapshot 재구성에서도 모든 구간을 계속 파싱한다.
  let currentEventOwned=true;
  const onOwnedEvent=<K extends keyof ChatParserEventMap>(event:K,callback:(value:ChatParserEventMap[K])=>void) => {
    syncParser.on(event,value=>{
      if (!currentEventOwned) return;
      if (currentFile?.knownLines) {
        currentLineKey ??= createChatLogLineKey(value.date,value.timestamp,currentLine,currentEventOffset);
        // 이 프로필이 실시간으로 바로 반영한 줄(줄 귀속 행 없음)은 이 프로필의 알려진 줄이다.
        const listed=Object.hasOwn(currentFile.knownLines,currentLineKey);
        const known=listed || appliedCurrentLine;
        if (known && (listed ? currentFile.knownLines[currentLineKey] : currentFile.aggregateOwnerKey)!==currentFile.aggregateOwnerKey) {foreignLine=true;return;}
        if (!known && legacyOwnsCurrentLine) lineKeys.add(currentLineKey);
        currentEventNew=!known && !legacyOwnsCurrentLine;
        repairOnly=known && currentFile.repairKnownActivities===true && !legacyOwnsCurrentLine;
      }
      callback(value);
    });
  };

  /** 재분석 복구 항목의 원본 위치(일지 행의 source_file_id/source_offset과 대조). */
  const repairSource=():{sourceFingerprint?:string;sourceOffset?:number} => repairOnly && currentFile?.fingerprint
    ? {sourceFingerprint:currentFile.fingerprint,sourceOffset:currentEventOffset} : {};

  const nextEventId = (kind: string): string => {
    if (!currentFile) throw new Error('현재 채팅 로그 파일이 없습니다.');
    if (currentLineKey) {
      lineKeys.add(currentLineKey);
      return createStableChatSyncEventId(currentLineKey,0,kind,currentEventSequence++);
    }
    return createStableChatSyncEventId(currentFile.fingerprint,currentEventOffset,kind,currentEventSequence++);
  };

  const mergeHomeworkAggregate = (
    target: Record<string, { count: number; isIncrement: boolean }>,
    id: string,
    count: number,
    isIncrement: boolean,
  ): void => {
    const existing = target[id];
    if (!existing) {
      target[id] = { count, isIncrement };
    } else if (isIncrement) {
      target[id] = { count: existing.count + count, isIncrement: existing.isIncrement };
    } else {
      target[id] = { count: Math.max(existing.count, count), isIncrement: false };
    }
  };

  const recordHomework = (id: string, count: number, isIncrement: boolean) => {
    if (!aggregate || currentEventTimestamp <= 0) return;
    const cycle = homeworkCycleKeys[id];
    if (!cycle) return;
    if (cycle.replayExclusions?.some(range=>currentEventTimestamp>=range.start && currentEventTimestamp<=range.end)) return;
    if (currentLineKey && currentEventNew) lineKeys.add(currentLineKey);

    // 모험일지는 현재 주기 여부와 무관하게 실제 이벤트가 속한 리셋 주기별로 보존한다.
    // 체크리스트용 `homework`와 섞으면 지난주 이벤트가 현재 횟수에 합산되므로 별도 집계가 필수다.
    const eventCycleKey = getHomeworkResetCycleKey(cycle.rule, currentEventTimestamp);
    const cycleHistory = aggregate.homeworkByCycle[eventCycleKey] || {};
    mergeHomeworkAggregate(cycleHistory, id, count, isIncrement);
    cycleHistory[id].latestTimestamp = Math.max(
      (cycleHistory[id] as { latestTimestamp?: number }).latestTimestamp || 0,
      currentEventTimestamp,
    );
    aggregate.homeworkByCycle[eventCycleKey] = cycleHistory as ChatLogFileAggregate['homeworkByCycle'][string];

    // 실제 체크리스트 상태는 기존 정책대로 현재 리셋 주기의 이벤트만 반영한다.
    if (eventCycleKey === cycle.cycleKey) {
      mergeHomeworkAggregate(aggregate.homework, id, count, isIncrement);
    }
  };

  onOwnedEvent('ETERNAL_FLOOR_CLEAR', () => {
    recordHomework('weekly-eternal-floor', 1, true);
  });

  onOwnedEvent('ECLIPSE_BOSS_CLEAR', (evt) => {
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

  onOwnedEvent('MERCURIAL_BOSS_CLEAR', (evt) => {
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

  onOwnedEvent('CORE_MASTER_CLEAR', (evt) => {
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

  onOwnedEvent('RELIC_SANCTUARY_CLEAR', (evt) => {
    recordHomework('weekly-ancient-relic', evt.count, false);
  });

  onOwnedEvent('POWER_ROOT_CLEAR', (evt) => {
    recordHomework('weekly-power-root', evt.count, false);
  });

  onOwnedEvent('ABYSS_TREASURE_ENTRY', (evt) => {
    recordHomework('weekly-abyss-treasure', evt.count, false);
  });

  onOwnedEvent('ECLIPSE_SUPPLIES_CLEAR', (evt) => {
    recordHomework('weekly-eclipse-recapture-supplies', evt.count, false);
  });

  onOwnedEvent('ECLIPSE_SPECIAL_FORCE_CLEAR', (evt) => {
    recordHomework('weekly-eclipse-special-force-suppression', evt.count, false);
  });

  onOwnedEvent('FORTRESS_GHOST_CLEAR', (evt) => {
    recordHomework('weekly-fortress-ghost', evt.count, false);
  });

  onOwnedEvent('TESIS_CORE_CLEAR', () => {
    recordHomework('weekly-tesis-core', 1, true);
  });

  onOwnedEvent('DIGSITE_ENTRY', (evt) => {
    if (typeof evt.count === 'number') {
      recordHomework('weekly-digsite', evt.count, false);
    } else {
      recordHomework('weekly-digsite', 1, true);
    }
  });

  onOwnedEvent('CONTENT_SHINJO_NEST_CLEAR', (evt) => {
    recordHomework('weekly-shinjo-nest', evt.count, false);
  });

  onOwnedEvent('ABYSS_DUNGEON_CLEAR', (evt) => {
    const depthMap: Record<string, string> = {
      '심층Ⅰ': 'weekly-abyss-dungeon-1',
      '심층Ⅱ': 'weekly-abyss-dungeon-2',
      '심층Ⅲ': 'weekly-abyss-dungeon-3'
    };
    const id = depthMap[evt.depth];
    if (id) recordHomework(id, evt.count, false);
  });

  onOwnedEvent('ABYSS_BOSS_EX_CLEAR', (evt) => {
    recordHomework('weekly-abyss-boss-ex', evt.count, false);
  });

  onOwnedEvent('SIOKAN_BOSS_CLEAR', (evt) => {
    recordHomework('weekly-siokan-boss', evt.count, false);
  });

  onOwnedEvent('SIOKAN_ODIN_CLEAR', (evt) => {
    recordHomework('weekly-siokan-odin', evt.count, false);
  });

  onOwnedEvent('ECLIPSE_BOSS_SUBJUGATION_CLEAR', (evt) => {
    recordHomework('weekly-eclipse-boss', evt.count, false);
  });

  onOwnedEvent('MOON_QUEEN_TRAINING_CLEAR', (evt) => {
    recordHomework('weekly-moon-queen', evt.count, false);
  });

  onOwnedEvent('APETHIRIA_RAID_CLEAR', (evt) => {
    recordHomework('weekly-apethiria-raid', evt.count, false);
  });

  onOwnedEvent('PRAVA_DEFENSE_CLEAR', () => {
    recordHomework('weekly-prava-defense', 1, true);
  });

  onOwnedEvent('ORLY_DEFENSE_CLEAR', () => {
    recordHomework('weekly-orly-defense', 1, true);
  });

  onOwnedEvent('CATACOMB_CLEAR', () => {
    recordHomework('weekly-catacomb-hell', 1, true);
  });

  onOwnedEvent('VESTIGE_CLEAR', () => {
    recordHomework('weekly-vestige', 1, true);
  });

  onOwnedEvent('THURSDAY_CLEAN_CLEAR', () => {
    recordHomework('weekly-thursday-clean', 1, true);
  });

  onOwnedEvent('ETA_DAILY_BOX_GAIN', () => {
    recordHomework('daily-eta-quest', 1, true);
  });

  onOwnedEvent('ETA_WILL_UPGRADE_GAIN', () => {
    recordHomework('daily-eta-will-upgrade', 1, true);
  });

  onOwnedEvent('CLUB_POINT_500_GAIN', () => {
    recordHomework('daily-club-boss', 1, true);
  });

  onOwnedEvent('CONFUSED_LAND_CLEAR', () => {
    recordHomework('daily-confused-land', 1, true);
  });

  onOwnedEvent('COLORLESS_LAND_CLEAR', () => {
    recordHomework('daily-colorless-land', 1, true);
  });

  onOwnedEvent('ARCHITECT_MINE_CLEAR', () => {
    recordHomework('daily-architect-mine', 1, true);
  });

  onOwnedEvent('GOLGOTHA_DEFENSE_CLEAR', () => {
    recordHomework('daily-golgotha-defense', 1, true);
  });

  onOwnedEvent('FINAL_BATTLE_CLEAR', () => {
    recordHomework('weekly-final-battle', 1, true);
  });

  onOwnedEvent('JOY_CLEAR', () => {
    recordHomework('daily-joy', 1, true);
  });

  onOwnedEvent('SORROW_CLEAR', () => {
    recordHomework('daily-sorrow', 1, true);
  });

  onOwnedEvent('ABANDONED_ENTRY', (evt) => {
    const regionMapping: Record<string, string> = {
      '필멸의 땅': 'weekly-abandon-road-mortal',
      '카디프': 'weekly-abandon-road-cardiff',
      '오를란느': 'weekly-abandon-road-orlanne'
    };
    const id = regionMapping[evt.region];
    if (id) recordHomework(id, evt.count, false);
  });

  onOwnedEvent('PITTA_ENTRY', (evt) => {
    const energy = typeof evt.energy === 'number' && !isNaN(evt.energy) ? evt.energy : 0;
    const computedCount = (20 - energy) + 1;
    if (computedCount >= 1 && computedCount <= 5) {
      recordHomework('daily-pitta', computedCount, false);
    }
  });

  onOwnedEvent('ABANDONED_FEE', (evt) => {
    if (!aggregate || (currentFile?.knownLines && !currentEventNew && !repairOnly) || !Number.isSafeInteger(evt.amount) || evt.amount <= 0) return;
    seeds.push({
      eventId: nextEventId('seed'),
      repairOnly,lineKey:repairOnly ? currentLineKey : undefined,...repairSource(),
      date: evt.date,
      timeOnly: evt.timestamp.replace(/ /g, '').replace(/[시분]/g, ':').replace('초', ''),
      content: `[자동] 어벤던로드 입장료 (-${evt.amount.toLocaleString('en-US')} SEED)`,
      amount: -evt.amount
    });
    aggregate.seedsDetected++;
  });

  onOwnedEvent('SEED_GAINED', (evt) => {
    if (!aggregate || (currentFile?.knownLines && !currentEventNew && !repairOnly)) return;
    const timeOnly = evt.timestamp.replace(/ /g, '').replace(/[시분]/g, ':').replace('초', '');
    const content = `[자동] ${evt.message} (${formatKoreanNumber(evt.amount)})`;
    seeds.push({
      eventId: nextEventId('seed'),
      repairOnly,lineKey:repairOnly ? currentLineKey : undefined,...repairSource(),
      date: evt.date,
      timeOnly,
      content,
      amount: evt.amount
    });
    aggregate.seedsDetected++;
  });

  // 파서 이벤트 리스너 등록
  onOwnedEvent('ITEM_LOOTED', (evt) => {
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
        if (currentFile?.knownLines && currentEventNew) {
          elsoEvents.push({eventId:nextEventId('elso'),date:evt.date,timeOnly,amount:elso});
        }
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
      if (currentFile?.knownLines && currentEventNew) {
        goldEvents.push({eventId:nextEventId('gold'),date:evt.date,timeOnly,amount:goldPouchSeed});
      }
    }

    // 실시간 처리와 동일하게 경험의 정수 직접 보상은 등록 목록과 무관하게 복원합니다.
    // 과거 로그 동기화가 lootKeywords를 그대로 따르더라도 이 예외를 제거하면 기존 사용자의
    // 모험일지·오늘 요약에서 경험의 정수가 통째로 사라집니다.
    const isAlwaysTrackedItem = isAlwaysTrackedLoot(evt.itemName);
    const shouldRecordItem = isAlwaysTrackedItem || matchesRegisteredLoot(lootKeywords, evt.itemName);
    const isMagicStone = evt.itemName.includes('마정석') || evt.message.includes('마정석');

    if (evt.isOwn && !isMagicStone && shouldRecordItem && (!currentFile?.knownLines || currentEventNew || repairOnly)) {
      const timeOnly = evt.timestamp.replace(/ /g, '').replace(/[시분]/g, ':').replace('초', '');
      if (isAlwaysTrackedItem) {
        essences.push({
          eventId: nextEventId('essence'),
          repairOnly,lineKey:repairOnly ? currentLineKey : undefined,...repairSource(),
          date: evt.date,
          timeOnly,
          diaryContent: formatLootDiaryContent('경험의 정수'),
          count: evt.count
        });
        aggregate.essencesDetected += evt.count;
      } else {
        loots.push({
          eventId: nextEventId('loot'),
          repairOnly,lineKey:repairOnly ? currentLineKey : undefined,...repairSource(),
          date: evt.date,
          timeOnly,
          diaryContent: formatLootDiaryContent(evt.itemName),
          count: evt.count
        });
        aggregate.lootsDetected++;
      }
    }
  });

  onOwnedEvent('MAGIC_STONE_GAIN', (evt) => {
    if (!aggregate) return;
    if (!matchesRegisteredLoot(lootKeywords, `${evt.grade} 마정석`)) return;
    const timeOnly = evt.timestamp.replace(/ /g, '').replace(/[시분]/g, ':').replace('초', '');
    const grade = evt.grade.trim();
    if (!aggregate.magicStones[evt.date]) aggregate.magicStones[evt.date] = {};
    const existing = aggregate.magicStones[evt.date][grade];
    aggregate.magicStones[evt.date][grade] = {
      latestTime: timeOnly,
      totalCount: (existing?.totalCount || 0) + evt.count,
    };
    aggregate.lootsDetected++;
    if (currentFile?.knownLines && currentEventNew) {
      loots.push({eventId:nextEventId('stone'),date:evt.date,timeOnly,diaryContent:formatLootDiaryContent(grade+' 마정석'),count:evt.count});
    }
  });

  onOwnedEvent('XP_CHANGED', (evt) => {
    if (!aggregate || (currentFile?.knownLines && !currentEventNew && !repairOnly)) return;
    // 수동·자동 교환 공통의 100억 감소만 환산합니다. 자동 교환의 복합 획득 안내는
    // ChatParser가 XP_CHANGED로 발행하지 않으므로 과거 로그에서도 중복되지 않습니다.
    // 이 전용 집계 역시 일반 등록 아이템 목록에 종속시키지 않습니다.
    const essenceCount = getEssenceExchangeCount(evt.amount);
    if (essenceCount > 0) {
      const timeOnly = evt.timestamp.replace(/ /g, '').replace(/[시분]/g, ':').replace('초', '');
      essences.push({
        eventId: nextEventId('essence-xp'),
      repairOnly,lineKey:repairOnly ? currentLineKey : undefined,...repairSource(),
        date: evt.date,
        timeOnly,
        diaryContent: formatLootDiaryContent('경험의 정수'),
        count: essenceCount
      });
      aggregate.essencesDetected += essenceCount;
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
          shoutKind: evt.shoutKind,
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
    elsoEvents = [];
    goldEvents = [];
    lineKeys.clear();
    let linesSinceBatch = 0;
    let confirmedOffset = file.startOffset;
    foreignLine=false;spanStart=file.startOffset;lastLineStart=undefined;ownedSpans=[];

    const sendProgress = (offset: number, completed: boolean): void => {
      const fileProgress = file.snapshotSize > 0 ? Math.min(1, offset / file.snapshotSize) : 1;
      const percent = completed
        ? 10 + Math.round(((fileIdx + 1) / targetFiles.length) * 85)
        : Math.min(94, 10 + Math.round(((fileIdx + fileProgress) / targetFiles.length) * 85));
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
          phase: 'analyzing',
          failedFiles: [...failedFiles],
        }
      });
    };

    const sendBatch = async (offset: number, fileComplete: boolean): Promise<void> => {
      if (!aggregate) throw new Error('채팅 로그 파일 누적 상태가 없습니다.');
      const aggregateLoots: ParsedLootEvent[] = [];
      const aggregateElso = [] as ChatLogSyncBatchData['elsoPoints'];
      const aggregateGoldPouchSeeds: NonNullable<ChatLogSyncBatchData['goldPouchSeeds']> = [];
      if (fileComplete && !file.knownLines) {
        for (const [date, grades] of Object.entries(aggregate.magicStones)) {
          for (const [grade, info] of Object.entries(grades)) {
            aggregateLoots.push({
              eventId:createStableChatSyncEventId(file.fingerprint,0,`daily-stone:${date}:${grade}${file.aggregateOwnerKey ? ':'+file.aggregateOwnerKey : ''}`,0),
              date,
              timeOnly: info.latestTime,
              diaryContent: `[득템] [${grade} 마정석]`,
              count: info.totalCount,
            });
          }
        }
        for (const [date, info] of Object.entries(aggregate.elsoByDate)) {
          const amount=info.totalAmount;
          if (amount>0) aggregateElso.push({eventId:createStableChatSyncEventId(file.fingerprint,0,`daily-elso:${date}${file.aggregateOwnerKey ? ':'+file.aggregateOwnerKey : ''}`,0),date,timeOnly:info.latestTime,amount});
        }
        for (const [date, info] of Object.entries(aggregate.goldPouchSeedByDate)) {
          const amount=info.totalAmount;
          if (amount>0) aggregateGoldPouchSeeds.push({eventId:createStableChatSyncEventId(file.fingerprint,0,`daily-gold:${date}${file.aggregateOwnerKey ? ':'+file.aggregateOwnerKey : ''}`,0),date,timeOnly:info.latestTime,amount});
        }
      }
      // 이 배치까지 처리한 구간을 닫는다. 마지막 줄이 제외·다른 소유면 그 줄 앞에서 끊는다.
      if (foreignLine) closeForeignLine();
      else if (offset > spanStart) ownedSpans.push({start:spanStart,end:offset});
      spanStart=offset;foreignLine=false;lastLineStart=undefined;
      const spans=ownedSpans;ownedSpans=[];
      const batch: ChatLogSyncBatchData = {
        jobId,
        batchId: `${jobId}:${fileIdx}:${batchSequence++}`,
        filePath: file.filePath,
        fileName: file.fileName,
        dateStr: file.dateStr,
        fingerprint: file.fingerprint,
        policyFingerprint: file.policyFingerprint,
        fingerprintBytes: file.fingerprintBytes,
        confirmedOffset: offset,
        snapshotSize: file.snapshotSize,
        fileComplete,
        aggregate: structuredClone(aggregate),
        loots: [...loots, ...aggregateLoots.filter(item=>item.count>0)],
        essences: [...essences],
        shouts: [...shouts],
        seeds: [...seeds],
        elsoPoints: file.knownLines ? elsoEvents : aggregateElso,
        goldPouchSeeds: file.knownLines ? goldEvents : aggregateGoldPouchSeeds,
        ...(file.knownLines ? {lineKeys:[...lineKeys],ownedSpans:spans} : {}),
        ...(fileComplete && file.replaceAutomaticDateOnComplete
          ? { replaceAutomaticDate: file.dateStr }
          : {}),
      };
      await postBatchAndWaitForAck(batch);
      loots = [];
      essences = [];
      shouts = [];
      seeds = [];
      elsoEvents = [];
      goldEvents = [];
      lineKeys.clear();
      linesSinceBatch = 0;
      confirmedOffset = offset;
    };

    try {
      syncParser.setCurrentDate(file.dateStr);
      const normalizer = new ChatLogLineNormalizer();
      let pendingStartOffset: number | null = null;
      let pendingOriginalLine: string | undefined;
      let carry = Buffer.alloc(0);
      let carryStartOffset = file.startOffset;

      let excludedIndex=0;
      const excluded=file.excludedRanges || [];
      const legacyOwned=file.legacyOwnedRanges || [];
      let legacyIndex=0;
      const applied=file.appliedRanges || [];
      let appliedIndex=0;
      const parseNormalizedLine = (line: string, eventOffset: number, originalLine = line): void => {
        // 앞 줄이 제외·다른 소유였다면 처리 구간을 그 줄 앞에서 끊고 이 줄부터 다시 시작한다.
        if (foreignLine) {closeForeignLine();spanStart=eventOffset;}
        lastLineStart=eventOffset;foreignLine=false;
        while (excludedIndex<excluded.length && excluded[excludedIndex].end<=eventOffset) ++excludedIndex;
        const range=excluded[excludedIndex];currentEventOwned=!range || eventOffset<range.start || eventOffset>=range.end;
        if (!currentEventOwned) foreignLine=true;
        while (legacyIndex<legacyOwned.length && legacyOwned[legacyIndex].end<=eventOffset) ++legacyIndex;
        legacyOwnsCurrentLine=legacyIndex<legacyOwned.length && eventOffset>=legacyOwned[legacyIndex].start;
        while (appliedIndex<applied.length && applied[appliedIndex].end<=eventOffset) ++appliedIndex;
        appliedCurrentLine=appliedIndex<applied.length && eventOffset>=applied[appliedIndex].start;
        currentEventOffset = eventOffset;
        currentEventSequence = 0;
        currentLine = originalLine;
        currentLineKey = undefined;
        currentEventNew = false;
        repairOnly = false;
        const timeMatch = line.match(/(\d{1,2})시\s*(\d{1,2})분\s*(\d{1,2})초/);
        if (timeMatch) {
          const [year, month, day] = file.dateStr.split('-').map(Number);
          currentEventTimestamp = new Date(
            year,
            month - 1,
            day,
            Number(timeMatch[1]),
            Number(timeMatch[2]),
            Number(timeMatch[3]),
          ).getTime();
        } else {
          currentEventTimestamp = 0;
        }
        if (line && !line.includes('회복되었습니다')) syncParser.parseLine(line);
      };

      const processRawLine = (rawLine: Buffer, lineStart: number, lineEnd: number): void => {
        if (!aggregate) return;
        let decodedLine = iconv.decode(rawLine, file.encoding);
        if (decodedLine.endsWith('\r')) decodedLine = decodedLine.slice(0, -1);
        const hadPending = normalizer.hasPending();
        const previousPendingStart = pendingStartOffset;
        const output = normalizer.push(decodedLine);

        output.forEach((line,index) => {
          const usesPending=hadPending && index===0;
          parseNormalizedLine(line,usesPending ? previousPendingStart ?? lineStart : lineStart,
            usesPending ? pendingOriginalLine ?? decodedLine : decodedLine);
        });
        if (normalizer.hasPending()) {
          if (!hadPending || output.length>0) {pendingStartOffset=lineStart;pendingOriginalLine=decodedLine;}
        } else {
          pendingStartOffset=null;pendingOriginalLine=undefined;
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
          if (bytesRead === 0) throw new Error('복원 중 채팅 로그 파일이 줄었습니다. 파일을 확인한 뒤 다시 시도해 주세요.');
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

            const bufferedEventCount = loots.length + essences.length + shouts.length + seeds.length + elsoEvents.length + goldEvents.length + lineKeys.size;
            const shouldFlushOrReport = file.replaceAutomaticDateOnComplete
              ? linesSinceBatch >= CHAT_SYNC_BATCH_LINE_LIMIT
              : (linesSinceBatch >= CHAT_SYNC_BATCH_LINE_LIMIT
                || bufferedEventCount >= CHAT_SYNC_BATCH_EVENT_LIMIT);
            if (!normalizer.hasPending() && shouldFlushOrReport) {
              if (file.replaceAutomaticDateOnComplete) {
                // 오늘 기록은 최종 배치 한 번으로 교체해야 하므로 중간에는 진행률만 알린다.
                sendProgress(confirmedOffset, false);
                linesSinceBatch = 0;
              } else {
                await sendBatch(confirmedOffset, false);
                sendProgress(confirmedOffset, false);
              }
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
          pending.forEach(line => parseNormalizedLine(line, pendingStartOffset ?? confirmedOffset,pendingOriginalLine));
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
      sendProgress(confirmedOffset, false);
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
