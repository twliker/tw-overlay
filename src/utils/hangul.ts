// 한글 초성 검색 공통 유틸리티 (윈도우 전역 객체 바인딩 방식)

interface Window {
  HangulUtils: {
    CHOSUNGS: string[];
    getChosungString(str: string): string;
    matchesSearch(name: string, category: string, query: string): boolean;
  };
}

const CHOSUNGS = [
  'ㄱ', 'ㄲ', 'ㄴ', 'ㄷ', 'ㄸ', 'ㄹ', 'ㅁ', 'ㅂ', 'ㅃ', 'ㅅ',
  'ㅆ', 'ㅇ', 'ㅈ', 'ㅉ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'
];

function getChosungString(str: string): string {
  let result = '';
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i) - 44032;
    if (code > -1 && code < 11172) {
      result += CHOSUNGS[Math.floor(code / 588)];
    } else {
      result += str.charAt(i).toLowerCase();
    }
  }
  return result;
}

function matchesChosungSearch(name: string, category: string, query: string): boolean {
  const cleanedQuery = query.toLowerCase().trim();
  if (!cleanedQuery) return true;

  const cleanedName = (name || '').toLowerCase();
  const cleanedCategory = (category || '').toLowerCase();

  const isConsonantQuery = /^[ㄱ-ㅎ\s]+$/.test(cleanedQuery);
  if (isConsonantQuery) {
    const nameChosung = getChosungString(name || '');
    const categoryChosung = getChosungString(category || '');
    return nameChosung.includes(cleanedQuery) || categoryChosung.includes(cleanedQuery);
  }

  return cleanedName.includes(cleanedQuery) || cleanedCategory.includes(cleanedQuery);
}

(window as any).HangulUtils = {
  CHOSUNGS,
  getChosungString,
  matchesSearch: matchesChosungSearch
};
