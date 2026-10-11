import { useMemo } from 'react';
import useDashboardData from '../hooks/useDashboardData';
import { onsanAdjacentBerthNames } from './geoUtils';

// ─────────────────────────────────────────────────────────────────────────────
// 시연용 주입 화물 (2026-09-29)
//
// 화물 자료 생성기(data-pipeline gen_cargo_manifest)가 시연을 위해 실제 배 일부에 이웃 선석
// 화물과 섞이면 안 되는 화물(질산·황산·암모니아)을 넣는다. 그 행은 cargo_basis 가
// '시연-혼재충돌 …(의도적 주입)'으로 시작한다. 자료에만 적혀 있고 화면에는 없어서, 실제 배에
// 실제 위험물이 실린 것처럼 보였다 — 그 화물에서 나온 부적합 판정·게이트 잠금도 마찬가지다.
// 화면이 "이건 시연을 위해 넣은 것"이라고 스스로 말하게 한다.
// ─────────────────────────────────────────────────────────────────────────────

const norm = (s) => (s || '').replace(/\s+/g, '').toUpperCase();

export const isDemoBasis = (basis) => typeof basis === 'string' && basis.startsWith('시연');

/** 주입 화물 목록과 조회 함수들. 목록은 대시보드 자료(demo_injected)에서 온다. */
export function useDemoCargo() {
  const { data } = useDashboardData();
  const list = data?.demo_injected;
  return useMemo(() => {
    const items = list || [];
    const byShip = new Map();
    const byWharf = new Map();
    for (const e of items) {
      const s = norm(e.callsgn);
      if (s) byShip.set(s, [...(byShip.get(s) || []), e]);
      const w = norm(e.wharf);
      if (w) byWharf.set(w, [...(byWharf.get(w) || []), e]);
    }
    /** 이 배에 실린 주입 화물 */
    const ofShip = (callsgn) => byShip.get(norm(callsgn)) || [];
    /** 이 선석에 지금 있는 주입 화물 */
    const atWharf = (wharf) => byWharf.get(norm(wharf)) || [];
    /** 이웃 선석에 있는 주입 화물 */
    const nearWharf = (wharf) => (wharf ? onsanAdjacentBerthNames(wharf) : []).flatMap((n) => atWharf(n));
    /** 이 배·이 선석의 판정에 닿을 수 있는 주입 화물 — own: 자기 화물, near: 같은 선석 다른 배 + 이웃 선석 */
    const around = (callsgn, wharf) => {
      const own = ofShip(callsgn);
      const me = norm(callsgn);
      const near = wharf
        ? [...atWharf(wharf).filter((e) => norm(e.callsgn) !== me), ...nearWharf(wharf)]
        : [];
      return { own, near, any: own.length > 0 || near.length > 0 };
    };
    /** 이 이름의 화물이 이 선석(들)에 주입된 것인가 — berthText 는 '정일2부두 1·2선석' 같은 표시 문자열도 받는다 */
    const isInjectedAt = (cargoName, berthText) => items.some(
      (e) => e.cargo_name === cargoName && e.wharf && norm(berthText).includes(norm(e.wharf)),
    );
    return { list: items, ofShip, atWharf, nearWharf, around, isInjectedAt };
  }, [list]);
}

/** 칩에 마우스를 올렸을 때 나오는 설명 */
export function demoTitle(entries, derived = false) {
  const what = [...new Set(entries.map((e) => `${e.cargo_name}${e.wharf ? ` · ${e.wharf}` : ''}${e.vessel_name ? ` ${e.vessel_name}` : ''}`))].join(', ');
  return derived
    ? `가까운 선석에 시연을 위해 넣은 화물이 있습니다(${what}). 이 판정은 그 영향을 받았을 수 있습니다. 실제 신고 화물이 아닙니다.`
    : `시연을 위해 넣은 화물입니다(${what}). 실제 신고 화물이 아닙니다.`;
}
