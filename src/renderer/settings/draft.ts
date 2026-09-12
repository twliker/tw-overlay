/**
 * config-data 갱신 전의 사용자 초안만 보존한다. 라디오는 그룹별, 메뉴는 안정 ID별로 추적한다.
 * 즉시 저장 성공 시 제출한 필드/배열만 기준에 반영한다. 실패 또는 응답 대기 중 재편집은 초안으로 남긴다.
 * 선택지가 아직 없는 select는 초기화 전이며 기준에서 제외한다. 저장 중 수신해 이미 깨끗해진 값은
 * 늦은 성공 응답으로 되돌리지 않는다. 색상·단축키 같은 객체는 변경한 하위 항목만 저장 승인한다.
 * HUD 편집에서 저장 성공한 좌표는 이전 초안보다 우선한다. 나머지 필드와 저장 실패·취소는 보존한다.
 * 회귀: scripts/check-audit-regressions.ts의 실제 설정 수신·즉시 저장 경로.
 */
(() => {
  type Extras = Record<string, any>;
  type Field = { value: string; checked?: boolean; labelId?: string; label?: string };
  let baseline: Map<string, Field> | undefined;
  let baselineExtras: Extras = {};
  let saveSerial = 0;
  let refreshSerial = 0;
  const savedFieldSerials = new Map<string, number>();
  const savedExtraSerials = new Map<string, number>();
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
  function acknowledgeAfterRefresh(submitted: any, current: any, received: any): any {
    if (equal(current, received)) return structuredClone(received);
    if (object(submitted) && object(current) && object(received)) {
      const result: Extras = {};
      for (const key of new Set([...Object.keys(submitted), ...Object.keys(current), ...Object.keys(received)])) {
        const value = acknowledgeAfterRefresh(submitted[key], current[key], received[key]);
        if (value !== undefined) result[key] = value;
      }
      return result;
    }
    return structuredClone(submitted);
  }
  function fields(): Map<string, Field> {
    const values = new Map<string, Field>();
    document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input[id], select[id], textarea[id], input[type="radio"][name], input.menu-visible-check').forEach(field => {
      if (field instanceof HTMLInputElement && field.type === 'file') return;
      if (field instanceof HTMLSelectElement && field.options.length === 0) return;
      if (field instanceof HTMLInputElement && field.type === 'radio' && field.name) {
        const key = `radio:${field.name}`;
        if (!values.has(key)) values.set(key, { value: '' });
        if (field.checked) values.set(key, { value: field.value });
        return;
      }
      if (field instanceof HTMLInputElement && field.classList.contains('menu-visible-check')) {
        values.set(`menu:${field.value}`, { value: field.value, checked: field.checked });
        return;
      }
      const label = document.getElementById(`${field.id}-val`) || document.getElementById(field.id.replace(/-input$/, '-val'));
      values.set(field.id, { value: field.value, ...(field instanceof HTMLInputElement ? { checked: field.checked } : {}),
        ...(label && label !== field ? { labelId: label.id, label: label.textContent || '' } : {}) });
    });
    return values;
  }
  window.settingsDraft = {
    initializeNewFields() {
      if (!baseline) return;
      for (const [id, value] of fields()) {
        if (!baseline.has(id)) baseline.set(id, value);
      }
    },
    beforeSave(fieldIds: string[], extras: Extras = {}, readExtras: () => Extras = () => extras) {
      const serial = ++saveSerial;
      const submittedRefresh = refreshSerial;
      const submitted = new Map([...fields()].filter(([id]) => fieldIds.includes(id)));
      const submittedExtras = structuredClone(extras);
      const currentExtras = readExtras();
      // 커스텀 탭처럼 저장 성공 뒤에 화면에 넣는 값은 수신값으로 오인하지 않는다.
      const deferredExtras = new Set(Object.keys(extras).filter(key => !equal(extras[key], currentExtras[key])));
      return {
        commit() {
          baseline ||= new Map();
          const current = fields();
          const refreshed = refreshSerial !== submittedRefresh;
          const latestExtras = readExtras();
          for (const [id, value] of submitted) {
            if ((savedFieldSerials.get(id) || 0) > serial) continue;
            savedFieldSerials.set(id, serial);
            if (!refreshed || !equal(current.get(id), baseline.get(id))) baseline.set(id, value);
            // 채팅 창 크기도 저장 후에는 외부 resize를 다시 받을 수 있다.
            if (equal(current.get(id), value)) {
              const field = document.getElementById(id);
              if (field) delete field.dataset.userEditedSinceLoad;
            }
          }
          for (const [key, value] of Object.entries(submittedExtras)) {
            if ((savedExtraSerials.get(key) || 0) > serial) continue;
            savedExtraSerials.set(key, serial);
            baselineExtras[key] = refreshed && !deferredExtras.has(key)
              ? acknowledgeAfterRefresh(value, latestExtras[key], baselineExtras[key]) : value;
          }
        },
      };
    },
    beforeRefresh(extras: Extras, savedFieldIds: string[] = []) {
      const current = fields();
      const changes = new Map([...current].filter(([id, value]) => !savedFieldIds.includes(id)
        && baseline?.has(id) && !equal(baseline.get(id), value)));
      const active = document.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
      const focus = active?.id ? { id: active.id, start: active.selectionStart, end: active.selectionEnd } : null;
      const previousExtras = structuredClone(baselineExtras);
      const hadBaseline = baseline !== undefined;
      const localExtras = structuredClone(extras);
      return {
        restore(freshExtras: Extras): Extras {
          refreshSerial++;
          baseline = fields();
          baselineExtras = structuredClone(freshExtras);
          for (const [id, value] of changes) {
            if (id.startsWith('radio:')) {
              document.querySelectorAll<HTMLInputElement>('input[type="radio"][name]').forEach(radio => {
                if (radio.name === id.slice(6)) radio.checked = radio.value === value.value;
              });
              continue;
            }
            if (id.startsWith('menu:')) {
              document.querySelectorAll<HTMLInputElement>('.menu-visible-check').forEach(check => {
                if (check.value === id.slice(5)) check.checked = value.checked === true;
              });
              continue;
            }
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
