interface BuffConstants {
  STANDARD_BUFFS: readonly string[];
}

interface Window {
  buffConstants: BuffConstants;
}

(function exposeBuffConstants(globalObject: Window | null): void {
  const buffConstants: BuffConstants = Object.freeze({
    STANDARD_BUFFS: Object.freeze([
      'util_snowman',
      'dmg_potion_plus',
      'stat_trust_plus',
      'stat_izabel_fixed',
      'stat_izabel_ratio',
      'dmg_izabel',
      'dmg_club_p',
      'util_ampoule',
      'util_haste',
    ]),
  });

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = buffConstants;
  }
  if (globalObject) {
    globalObject.buffConstants = buffConstants;
  }
})(typeof window !== 'undefined' ? window : null);
