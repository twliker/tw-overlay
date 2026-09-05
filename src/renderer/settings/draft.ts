/** config-data 갱신 전의 사용자 초안만 보존한다. 수정하지 않은 입력과 배열은 최신 설정을 받는다. */
(() => {
  type Extras = Record<string, any>;
  type Field = { value: string; checked?: boolean; labelId?: string; label?: string };
  let baseline: Map<string, Field> | undefined;
  let baselineExtras: Extras = {};
  const equal = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
  const object = (value: unknown): value is Extras => !!value && typeof value === 'object' && !Array.isArray(value);
  function merge(base: any, local: any, remote: any): any {
    if (equal(base, local)) return structuredClone(remote);
    if (object(base) && object(local) && object(remote)) {
      const result: Extras = {};
      for (const key of new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)])) {
        if (!(key in local) && key in base) continue;
        result[key] = merge(base[key], local[key], remote[key]);
      }
      return result;
    }
    return structuredClone(local);
  }
  function fields(): Map<string, Field> {
    const values = new Map<string, Field>();
    document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input[id], select[id], textarea[id]').forEach(field => {
      if (field instanceof HTMLInputElement && field.type === 'file') return;
      const label = document.getElementById(`${field.id}-val`) || document.getElementById(field.id.replace(/-input$/, '-val'));
      values.set(field.id, { value: field.value, ...(field instanceof HTMLInputElement ? { checked: field.checked } : {}),
        ...(label && label !== field ? { labelId: label.id, label: label.textContent || '' } : {}) });
    });
    return values;
  }
  window.settingsDraft = {
    beforeRefresh(extras: Extras) {
      const current = fields();
      const changes = new Map([...current].filter(([id, value]) => baseline?.has(id) && !equal(baseline.get(id), value)));
      const active = document.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
      const focus = active?.id ? { id: active.id, start: active.selectionStart, end: active.selectionEnd } : null;
      const previousExtras = structuredClone(baselineExtras);
      const hadBaseline = baseline !== undefined;
      const localExtras = structuredClone(extras);
      return {
        restore(freshExtras: Extras): Extras {
          baseline = fields();
          baselineExtras = structuredClone(freshExtras);
          for (const [id, value] of changes) {
            const field = document.getElementById(id) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null;
            if (!field) continue;
            field.value = value.value;
            if (field instanceof HTMLInputElement && value.checked !== undefined) field.checked = value.checked;
            if (value.labelId) {
              const label = document.getElementById(value.labelId);
              if (label) label.textContent = value.label || '';
            }
          }
          if (focus) {
            const field = document.getElementById(focus.id) as HTMLInputElement | HTMLTextAreaElement | null;
            field?.focus({ preventScroll: true });
            if (focus.start !== null && focus.end !== null) {
              try { field?.setSelectionRange(focus.start, focus.end); } catch { /* number/range에는 선택 영역이 없다. */ }
            }
          }
          return hadBaseline ? merge(previousExtras, localExtras, freshExtras) : freshExtras;
        },
      };
    },
  };
})();
