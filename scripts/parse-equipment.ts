import fs = require('fs');
import path = require('path');

const RAW_DIR = path.join(__dirname, '..', '.gemini', 'planning', 'equipment_dic');
const RAW_RESOURCES_DIR = path.join(RAW_DIR, 'resources');
const OUT_JSON_PATH = path.join(__dirname, '..', 'src', 'assets', 'data', 'equipment_dic.json');
const OUT_IMG_DIR = path.join(__dirname, '..', 'src', 'assets', 'img', 'equipment');

type EquipmentGroup = '무기' | '갑옷' | '손목' | '아티팩트' | '세트' | '어빌리티' | '기타';

interface HtmlCell {
  text: string;
  colspan: number;
  rowspan: number;
  img: string | null;
}

type HtmlGrid = HtmlCell[][];

interface ParsedItem {
  name: string;
  category: string;
  group: EquipmentGroup;
  part: string;
  image: string;
  stats: Record<string, string>;
  maxStats: Record<string, string>;
  subCategory?: string;
  slots?: string;
  effects?: string;
  delay?: string;
  synth?: string;
  levelReq?: string;
  statReq?: string;
}

// Ensure output directories exist
if (!fs.existsSync(path.dirname(OUT_JSON_PATH))) {
  fs.mkdirSync(path.dirname(OUT_JSON_PATH), { recursive: true });
}
if (!fs.existsSync(OUT_IMG_DIR)) {
  fs.mkdirSync(OUT_IMG_DIR, { recursive: true });
}

// Group mapping based on filename
const WEAPONS = [
  '단검', '단도', '대검', '평도', '태도', '세검', '장검', '스태프', '로드', '메이스',
  '창', '봉', '채찍', '플레일', '스몰소드', '완드', '물리총', '마법총', '클로', '카라',
  '셉터', '핸드벨', '물리검', '마법검', '사이드', '해머', '토템', '핸드런처', '아밍소드', '소드셰이프',
  '도끼'
];
const ARMORS = [
  '아머', '메일', '마법갑옷', '슈츠', '로브', '아노마라드 공화국 시리즈', '아노마라드 왕국 시리즈'
];
const WRISTS = [
  '방패', '리스트', '밴드', '암릿', '수정구', '스펠북', '물리탄창', '마법탄창', '물리검(sub)', '마법검(sub)', '펜듈럼'
];
const ARTIFACTS = [
  '찌르기', '베기', '마법공격', '마법방어(신성)', '물리 복합', '마법 베기'
];

function getGroup(category: string): EquipmentGroup {
  if (WEAPONS.includes(category)) return '무기';
  if (ARMORS.includes(category)) return '갑옷';
  if (WRISTS.includes(category)) return '손목';
  if (ARTIFACTS.includes(category)) return '아티팩트';
  if (category.endsWith('장비 세트')) return '세트';
  if (category === '어빌리티') return '어빌리티';
  return '기타';
}

function getPart(name: string, category: string, group: EquipmentGroup): string {
  if (group === '무기') return 'weapon';
  if (group === '손목') return 'wrist';
  if (group === '아티팩트') return 'artifact';
  if (group === '어빌리티') return 'ability';

  if (group === '갑옷') {
    const cat = category || '';
    if (cat.includes('투구')) return 'helm';
    if (cat.includes('머리')) return 'amulet';
    if (cat.includes('갑옷') || cat.includes('아머') || cat.includes('메일') || cat.includes('로브') || cat.includes('슈츠') || cat.includes('네냐플 학원 시리즈')) {
      return 'armor';
    }
    if (cat.includes('손') || cat.includes('장갑')) return 'gauntlet';
    if (cat.includes('발') || cat.includes('신발')) return 'boots';
    if (cat.includes('몸') || cat.includes('등') || cat.includes('날개') || cat.includes('몸/날개')) return 'wing';
  }

  // group === '세트' 나 '기타'인 경우에도 이름 기반으로 유추
  const lname = (name || '').toLowerCase();
  if (lname.includes('헬름') || lname.includes('혼') || lname.includes('투구')) return 'helm';
  if (lname.includes('아뮬렛') || lname.includes('마스크') || lname.includes('머리')) return 'amulet';
  if (lname.includes('망토') || lname.includes('윙') || lname.includes('몸') || lname.includes('날개')) return 'wing';
  if (lname.includes('건틀렛') || lname.includes('손') || lname.includes('장갑')) return 'gauntlet';
  if (lname.includes('부츠') || lname.includes('슈즈') || lname.includes('다리')) return 'boots';
  if (lname.includes('갑옷') || lname.includes('아머') || lname.includes('메일') || lname.includes('로브') || lname.includes('슈츠') || (category && (category.includes('갑옷') || category.includes('아머') || category.includes('메일') || category.includes('로브') || category.includes('슈츠')))) return 'armor';

  return '';
}

function decodeHtml(html: string): string {
  if (!html) return '';
  return html
    .replace(/<[^>]+>/g, '') // remove HTML tags
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseHtmlFile(filePath: string): ParsedItem[] {
  const fileName = path.basename(filePath);
  const category = fileName.replace('.html', '');
  const group = getGroup(category);

  console.log(`Parsing ${fileName} [Group: ${group}]...`);

  const content = fs.readFileSync(filePath, 'utf8');

  // Extract table rows from tbody
  const tbodyStart = content.indexOf('<tbody>');
  const tbodyEnd = content.indexOf('</tbody>');
  if (tbodyStart === -1 || tbodyEnd === -1) {
    console.warn(`[WARN] Could not find tbody in ${fileName}`);
    return [];
  }

  const tbodyHtml = content.substring(tbodyStart + 7, tbodyEnd);

  const trMatches = tbodyHtml.match(/<tr[^>]*>([\s\S]*?)<\/tr>/gi) || [];
  const htmlRows = trMatches.map(tr => {
    const tdMatches = tr.match(/<(td|th)[^>]*>([\s\S]*?)<\/\1>/gi) || [];
    const filteredMatches = tdMatches.filter(td => {
      const isRowHeader = td.includes('row-header') || td.includes('row-headers-background');
      return !isRowHeader;
    });
    return filteredMatches.map(td => {
      const colspanMatch = td.match(/colspan="(\d+)"/i);
      const rowspanMatch = td.match(/rowspan="(\d+)"/i);
      const colspan = colspanMatch ? parseInt(colspanMatch[1], 10) : 1;
      const rowspan = rowspanMatch ? parseInt(rowspanMatch[1], 10) : 1;

      const imgMatch = td.match(/<img[^>]+src="([^"]+)"/i);
      // Clean image path (e.g. resources/cellImage_...jpg -> cellImage_...jpg)
      let img: string | null = null;
      if (imgMatch) {
        img = path.basename(imgMatch[1]);
      }

      return {
        text: decodeHtml(td),
        colspan,
        rowspan,
        img
      };
    });
  });

  // Reconstruct 2D grid of cell references to handle rowspans and colspans
  const grid: HtmlGrid = [];
  for (let r = 0; r < htmlRows.length; r++) {
    if (!grid[r]) grid[r] = [];
    const rowCells = htmlRows[r];
    for (let i = 0; i < rowCells.length; i++) {
      const cell = rowCells[i];
      // Find the first empty column index in grid[r]
      let c = 0;
      while (grid[r][c] !== undefined) {
        c++;
      }
      // Fill grid coordinate with this cell reference
      for (let dr = 0; dr < cell.rowspan; dr++) {
        const nr = r + dr;
        if (!grid[nr]) grid[nr] = [];
        for (let dc = 0; dc < cell.colspan; dc++) {
          const nc = c + dc;
          grid[nr][nc] = cell;
        }
      }
    }
  }

  if (category === '어빌리티') {
    return parseAbilityGrid(grid, category, group);
  } else {
    return parseEquipmentGrid(grid, category, group);
  }
}

function parseAbilityGrid(
  grid: HtmlGrid,
  category: string,
  group: EquipmentGroup,
): ParsedItem[] {
  const items: ParsedItem[] = [];
  let headerRowIdx = -1;

  // Find header row (must contain '아이템', '효과')
  for (let r = 0; r < grid.length; r++) {
    const row = grid[r];
    if (row && row.some(cell => cell && cell.text.includes('아이템')) && row.some(cell => cell && cell.text.includes('효과'))) {
      headerRowIdx = r;
      break;
    }
  }

  if (headerRowIdx === -1) {
    console.warn(`[WARN] Could not find header row in Ability sheet.`);
    return [];
  }

  // Identify column roles
  const headerRow = grid[headerRowIdx];
  const colMap: Record<number, 'name' | 'slots' | 'mainEffect' | 'subEffects'> = {};
  for (let c = 0; c < headerRow.length; c++) {
    const cell = headerRow[c];
    if (cell && cell.text) {
      if (cell.text.includes('아이템')) colMap[c] = 'name';
      else if (cell.text.includes('개수')) colMap[c] = 'slots';
      else if (cell.text.includes('효과')) {
        // First '효과' is main effect, second is sub effects
        if (!Object.values(colMap).includes('mainEffect')) {
          colMap[c] = 'mainEffect';
        } else {
          colMap[c] = 'subEffects';
        }
      }
    }
  }

  let currentSubCategory = '';

  for (let r = headerRowIdx + 1; r < grid.length; r++) {
    const row = grid[r];
    if (!row || row.length === 0) continue;

    // Check if it's a sub-category title row (e.g. "매서운 칼날(찌르기/STAB)")
    // Defined by all columns pointing to the same cell and colspan >= 4
    const uniqueCell = row[0];
    const isSubTitle = row.every(cell => cell === uniqueCell) && uniqueCell && uniqueCell.colspan >= 4;

    if (isSubTitle) {
      if (uniqueCell.text && !uniqueCell.text.includes('목차')) {
        currentSubCategory = uniqueCell.text;
      }
      continue;
    }

    // Ability item row
    // Col 0 and 1 are typically merged for Item Name
    const nameCell = row[0];
    if (nameCell && nameCell.text && nameCell.text.trim() && !nameCell.text.includes('목차') && nameCell.text.trim() !== '아이템' && nameCell.text.trim() !== '효과' && nameCell !== grid[r - 1]?.[0]) {
      const item: ParsedItem = {
        name: nameCell.text.replace(/\s+/g, ' '),
        category: category,
        subCategory: currentSubCategory,
        group: group,
        part: getPart(nameCell.text, category, group),
        image: '',
        stats: {},
        maxStats: {},
        slots: '',
        effects: ''
      };

      // Extract main effect, slots, sub effects using colMap
      const seenCells = new Set<HtmlCell>();
      for (let c = 0; c < row.length; c++) {
        const cell = row[c];
        if (!cell || seenCells.has(cell)) continue;
        seenCells.add(cell);

        const role = colMap[c];
        if (role === 'mainEffect') {
          item.stats['기본효과'] = cell.text;
        } else if (role === 'slots') {
          item.slots = cell.text;
        } else if (role === 'subEffects') {
          item.effects = cell.text;
        }
      }

      items.push(item);
    }
  }

  return items;
}

function parseEquipmentGrid(
  grid: HtmlGrid,
  category: string,
  group: EquipmentGroup,
): ParsedItem[] {
  const items: ParsedItem[] = [];
  let headerRowIdx = -1;
  const keyMapping: Record<string, string> = {
    '찌르기': 'stab',
    '베기': 'hack',
    '방어': 'def',
    '마공': 'mag_atk',
    '마방': 'mag_def',
    '명중': 'hit',
    '회피': 'eva',
    '민첩함': 'agi',
    '민첩': 'agi',
    '크리': 'cri',
    '딜레이': 'delay',
    '합성': 'synth',
    '합성 횟수': 'synth',
    '조건': 'req'
  };

  // 부분일치(includes)는 짧은 키가 긴 키의 접두사일 때 엉뚱한 컬럼을 잡으므로,
  // 정확매칭을 우선하고 부분매칭은 긴 키부터 시도한다.
  const mappingKeys = Object.keys(keyMapping).sort((a, b) => b.length - a.length);
  const matchKey = (text: string): string | undefined => (
    mappingKeys.find(k => text === k)
    || mappingKeys.find(k => text.includes(k))
  );

  // Find header row containing at least 2 matching keywords
  for (let r = 0; r < grid.length; r++) {
    const row = grid[r];
    if (!row) continue;
    let matchCount = 0;
    row.forEach(cell => {
      if (cell && cell.text && matchKey(cell.text)) {
        matchCount++;
      }
    });
    if (matchCount >= 2) {
      headerRowIdx = r;
      break;
    }
  }

  if (headerRowIdx === -1) {
    console.warn(`[WARN] Could not find header row in ${category}`);
    return [];
  }

  const headerRow = grid[headerRowIdx];
  const colMap: Record<number, string> = {};

  for (let c = 0; c < headerRow.length; c++) {
    const cell = headerRow[c];
    if (cell && cell.text) {
      const matchedKey = matchKey(cell.text);
      if (matchedKey) {
        colMap[c] = keyMapping[matchedKey];
      }
    }
  }

  // Scan items
  for (let r = headerRowIdx + 1; r < grid.length; r++) {
    const row = grid[r];
    if (!row || row.length === 0) continue;

    // Check if it's an item name row
    const firstCell = row[0];
    const isItemNameRow = firstCell && firstCell.colspan >= 4 && firstCell.text && firstCell.text.trim() !== '' && !firstCell.text.includes('목차') && !firstCell.text.includes('바로가기') && row.slice(0, Math.min(row.length, firstCell.colspan)).every(cell => cell === firstCell);

    if (isItemNameRow) {
      const itemName = firstCell.text.trim();
      let name = itemName;
      let dmgPct = null;
      let redPct = null;

      // Parse damage resistance
      const redMatch = name.match(/피해\s*(?:저항|감소)\s*\+?\s*(\d+)%/);
      if (redMatch) redPct = redMatch[1];

      // Parse damage %
      const dmgMatch = name.match(/(?:찌르기|베기|물리\s*복합|마법|마법\s*베기|신성)?\s*공격력\s*\+?\s*(\d+)%/);
      if (dmgMatch) dmgPct = dmgMatch[1];

      // Clean up names
      name = name.replace(/\s*\([^)]*?\d+%\s*\)/g, '');
      name = name.replace(/\s*-\s*[^-\n]*?\d+%\s*/g, '');
      name = name.replace(/\s*(?:찌르기|베기|물리\s*복합|마법|마법\s*베기|신성)?\s*공격력\s*\+?\s*\d+%\s*/g, '');
      name = name.replace(/\s*-\s*$/g, '');
      name = name.trim();

      const item: ParsedItem = {
        name: name,
        category: category,
        group: group,
        part: getPart(name, category, group),
        image: '',
        stats: {},
        maxStats: {},
        delay: '',
        synth: '',
        levelReq: '',
        statReq: ''
      };

      if (dmgPct) item.stats.damage_pct = dmgPct + '%';
      if (redPct) item.stats.dmg_red_pct = redPct + '%';

      // Read next rows: r+1 (base stats), r+2 (requirements), r+3 (max stats)
      const rBase = r + 1;
      const rReq = r + 2;
      const rMax = r + 3;

      if (rBase < grid.length && grid[rBase]) {
        const baseRow = grid[rBase];
        const seenCells = new Set<HtmlCell>();
        for (let c = 0; c < baseRow.length; c++) {
          const cell = baseRow[c];
          if (!cell || seenCells.has(cell)) continue;
          seenCells.add(cell);

          // Image cell
          if (cell.img) {
            item.image = cell.img;
            copyImage(cell.img);
          }

          const role = colMap[c];
          if (role && role !== 'req' && role !== 'synth' && role !== 'delay') {
            // Standard stat range
            if (cell.text && cell.text !== '-' && cell.text !== '') {
              item.stats[role] = cell.text;
            }
          } else if (role === 'delay') {
            item.delay = cell.text;
          } else if (role === 'synth') {
            item.synth = cell.text;
          } else if (role === 'req') {
            item.levelReq = cell.text;
          }
        }
      }

      if (rReq < grid.length && grid[rReq]) {
        // Column mapping for req is typically the last column
        const reqColIdx = Object.entries(colMap)
          .find(([, role]) => role === 'req')?.[0];
        if (reqColIdx !== undefined) {
          const reqCell = grid[rReq][parseInt(reqColIdx, 10)];
          // Ensure it is not spanned from base row
          if (reqCell && grid[rBase] && reqCell !== grid[rBase][parseInt(reqColIdx, 10)]) {
            item.statReq = reqCell.text;
          }
        }
      }

      if (rMax < grid.length && grid[rMax]) {
        const maxRow = grid[rMax];
        // Since Column 0 (image) is spanned from rBase, column mapping starts offset.
        // We can just align using column index c of the grid.
        const seenCells = new Set<HtmlCell>();
        for (let c = 0; c < maxRow.length; c++) {
          const cell = maxRow[c];
          if (!cell || seenCells.has(cell)) continue;
          seenCells.add(cell);

          // Skip if cell is spanned from rBase (like image or synth/delay/levelReq columns)
          if (grid[rBase] && cell === grid[rBase][c]) continue;

          const role = colMap[c];
          if (role && role !== 'req' && role !== 'synth' && role !== 'delay') {
            if (cell.text && cell.text !== '-' && cell.text !== '' && cell.text !== '한계치') {
              item.maxStats[role] = cell.text;
            }
          }
        }
      }

      items.push(item);
      r = Math.min(grid.length - 1, r + 3); // Skip the stat rows, but bound to grid length
    }
  }

  return items;
}

function copyImage(imgName: string): void {
  const srcPath = path.join(RAW_RESOURCES_DIR, imgName);
  const destPath = path.join(OUT_IMG_DIR, imgName);

  if (fs.existsSync(srcPath)) {
    try {
      fs.copyFileSync(srcPath, destPath);
    } catch (err) {
      console.error(`Error copying image ${imgName}:`, err);
    }
  } else {
    console.warn(`[WARN] Image not found in resources: ${imgName}`);
  }
}

const NENAPLE_ITEMS: ParsedItem[] = [
  {
    "name": "네냐플 학원의 메일",
    "category": "네냐플 학원 시리즈",
    "group": "갑옷",
    "part": "armor",
    "image": "nenaple_mail.png",
    "stats": {
      "stab": "50",
      "hack": "50",
      "def": "340",
      "mag_atk": "50",
      "mag_def": "270",
      "hit": "80",
      "eva": "0",
      "agi": "0",
      "cri": "70"
    },
    "maxStats": {
      "stab": "140",
      "hack": "140",
      "def": "400",
      "mag_atk": "140",
      "mag_def": "310",
      "hit": "100",
      "eva": "0",
      "agi": "0",
      "cri": "100"
    },
    "delay": "",
    "synth": "MAX",
    "levelReq": "Lv310",
    "statReq": ""
  },
  {
    "name": "네냐플 학원의 아머",
    "category": "네냐플 학원 시리즈",
    "group": "갑옷",
    "part": "armor",
    "image": "nenaple_armor.png",
    "stats": {
      "stab": "50",
      "hack": "50",
      "def": "270",
      "mag_atk": "50",
      "mag_def": "245",
      "hit": "0",
      "eva": "120",
      "agi": "0",
      "cri": "0"
    },
    "maxStats": {
      "stab": "140",
      "hack": "140",
      "def": "310",
      "mag_atk": "140",
      "mag_def": "290",
      "hit": "0",
      "eva": "150",
      "agi": "0",
      "cri": "0"
    },
    "delay": "",
    "synth": "MAX",
    "levelReq": "Lv310",
    "statReq": ""
  },
  {
    "name": "네냐플 학원의 로브",
    "category": "네냐플 학원 시리즈",
    "group": "갑옷",
    "part": "armor",
    "image": "nenaple_robe.png",
    "stats": {
      "stab": "50",
      "hack": "50",
      "def": "270",
      "mag_atk": "50",
      "mag_def": "275",
      "hit": "95",
      "eva": "100",
      "agi": "0",
      "cri": "0"
    },
    "maxStats": {
      "stab": "140",
      "hack": "140",
      "def": "310",
      "mag_atk": "140",
      "mag_def": "330",
      "hit": "120",
      "eva": "120",
      "agi": "0",
      "cri": "0"
    },
    "delay": "",
    "synth": "MAX",
    "levelReq": "Lv310",
    "statReq": ""
  },
  {
    "name": "네냐플 학원의 슈츠",
    "category": "네냐플 학원 시리즈",
    "group": "갑옷",
    "part": "armor",
    "image": "nenaple_suits.png",
    "stats": {
      "stab": "50",
      "hack": "50",
      "def": "245",
      "mag_atk": "50",
      "mag_def": "0",
      "hit": "0",
      "eva": "215",
      "agi": "90",
      "cri": "0"
    },
    "maxStats": {
      "stab": "140",
      "hack": "140",
      "def": "290",
      "mag_atk": "140",
      "mag_def": "0",
      "hit": "0",
      "eva": "250",
      "agi": "130",
      "cri": "0"
    },
    "delay": "",
    "synth": "MAX",
    "levelReq": "Lv310",
    "statReq": ""
  }
];

// Main execution block
function run() {
  if (!fs.existsSync(RAW_DIR)) {
    // 절대 기존 JSON을 manual 항목만으로 덮어쓰지 않는다. raw 파일 없이 실행하면
    // 커밋된 사전 전체가 4개 항목으로 소실되므로 write 없이 중단한다.
    console.error(`[ERROR] Raw resources directory not found: ${RAW_DIR}`);
    console.error(`Place the raw equipment HTML files in .gemini/planning/equipment_dic/ before running.`);
    console.error(`Aborting without modifying ${OUT_JSON_PATH} to avoid wiping existing data.`);
    process.exitCode = 1;
    return;
  }

  const files = fs.readdirSync(RAW_DIR);
  let allItems: ParsedItem[] = [];

  files.forEach(file => {
    if (!file.endsWith('.html')) return;
    if (file === '목차.html' || file === '무기 확장.html' || file === '갑옷 확장의 사본.html' || file === '어빌리티.html') {
      console.log(`Skipping metadata/ability file: ${file}`);
      return;
    }

    const filePath = path.join(RAW_DIR, file);
    try {
      const items = parseHtmlFile(filePath);
      allItems = allItems.concat(items);
    } catch (e) {
      console.error(`Error parsing file ${file}:`, e);
    }
  });

  // Append manual custom items
  allItems = allItems.concat(NENAPLE_ITEMS);

  fs.writeFileSync(OUT_JSON_PATH, JSON.stringify(allItems, null, 2), 'utf8');
  console.log(`\n🎉 Success! Extracted ${allItems.length} items to ${OUT_JSON_PATH}`);
}

run();
