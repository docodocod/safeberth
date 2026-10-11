// ─────────────────────────────────────────────
// 스냅샷 모드 — 서버 없이 열리는 배포본용 fetch 가로채기
//
// 대시보드 데이터는 함현우 PC 의 DB 에서 나오므로 PC 가 꺼지면 공개 주소가 빈
// 화면이 된다. VITE_SNAPSHOT=1 로 빌드하면 이 모듈이 fetch 를 감싸서 API 호출을
// 같이 배포된 snapshot.json 으로 응답한다 → 정적 호스팅(무료)에 올려도 화면이 산다.
//
// 굳힌 시점의 데이터라 실시간이 아니다. 스냅샷에 없는 경로(챗봇·안전판정 등
// 입력값을 받는 API)는 503 으로 돌려주고, 화면은 각자의 실패 처리(판단불가 등)를
// 그대로 타게 둔다 — 없는 데이터를 지어내지 않기 위해서다.
// ─────────────────────────────────────────────
const ENABLED = import.meta.env.VITE_SNAPSHOT === '1';

export const IS_SNAPSHOT = ENABLED;

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

if (ENABLED && typeof window !== 'undefined') {
  const nativeFetch = window.fetch.bind(window);
  const loading = fetch('./snapshot/snapshot.json')
    .then((r) => (r.ok ? r.json() : {}))
    .catch(() => ({}));

  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input?.url ?? '';
    // 스냅샷은 API 만 대신한다. 정적 파일·지도 타일 등은 원래 fetch 로 보낸다.
    if (!url.includes('/api/')) return nativeFetch(input, init);

    const snap = await loading;
    const path = url.startsWith('http') ? new URL(url).pathname : url.split('?')[0];

    // 선석별 기상 판정은 body 의 berth_group 으로 갈라 저장해 뒀다
    if (path.endsWith('/weather/assess')) {
      const byGroup = snap['/api/v1/weather/assess'] || {};
      let group = null;
      try {
        group = JSON.parse(init?.body ?? '{}').berth_group;
      } catch { /* body 파싱 실패 시 아래 503 */ }
      if (group && byGroup[group]) return jsonResponse(byGroup[group]);
    }

    // 챗봇 질의 — 질문 문장으로 갈라 저장해 뒀다(추천 질문 4개는 문구가 고정이라
    // 미리 녹화할 수 있다). cargo_hint 는 키에서 뺀다 — 같은 질문에 힌트 유무로
    // 본문이 갈라져도 답은 같아야 하기 때문.
    // 녹화에 없는 자유 질문은 503 이 아니라 '답변' 형태로 한계를 말한다 —
    // 챗봇 말풍선에 그대로 떠서, 사용자가 왜 안 되는지 그 자리에서 알 수 있다.
    if (path.endsWith('/rag/query')) {
      const byQuestion = snap['/api/v1/rag/query'] || {};
      let q = null;
      try { q = (JSON.parse(init?.body ?? '{}').question || '').trim(); } catch { /* 아래 안내 */ }
      if (q && byQuestion[q]) return jsonResponse(byQuestion[q]);
      return jsonResponse({
        answer: '이 공개 데모는 미리 저장된 추천 질문에만 답할 수 있습니다. '
          + '아래 추천 질문 버튼을 눌러 보세요. 자유 질문은 실시간 관제 서버에서 지원됩니다.',
        citations: [],
        confidence: 'low',
      });
    }

    // 종합 판정은 호출부호로 갈라 저장해 뒀다.
    if (path.endsWith('/orchestrator/assess')) {
      const byCallSign = snap['/api/v1/orchestrator/assess'] || {};
      try {
        const cs = JSON.parse(init?.body ?? '{}').vessel?.call_sign;
        if (cs && byCallSign[cs]) return jsonResponse(byCallSign[cs]);
      } catch { /* 아래 503 */ }
      return jsonResponse(
        { detail: '스냅샷 배포본에 이 선박의 종합 판정이 없습니다 - 실시간 서버가 필요합니다' },
        503,
      );
    }

    // 판정 기록·확인은 상태를 바꾸는 동작이라 정적 배포본에서 할 수 없다.
    // 없는 성공을 지어내지 않고, 왜 안 되는지 그대로 말한다.
    //
    // [2026-09-22] 가로채는 경로를 바꿨다. 옛 이름(/assess-and-commit ·
    // /orchestrator/reject · /approvals/{id}/decision)은 백엔드에서 없어졌다 —
    // 우리가 선석을 배정하지 않기로 하면서 승인·반려라는 동작 자체가 사라졌다.
    if (path.endsWith('/orchestrator/assess-and-record')) {
      return jsonResponse(
        { detail: '이 공개 데모는 조회 전용입니다 — 판정 기록은 실시간 관제 서버에서 남깁니다.', read_only: true },
        503,
      );
    }

    if (path.includes('/approvals/') && path.endsWith('/acknowledge')) {
      return jsonResponse(
        { detail: '이 공개 데모는 조회 전용입니다 — 판정 확인은 실시간 관제 서버에서 기록됩니다.', read_only: true },
        503,
      );
    }

    // 안전 심사는 '대상 화물 + 인접 선석 재항 화물' 조합으로 갈라 저장해 뒀다.
    // 입력이 정확히 같을 때만 캐시를 쓴다 — 인접 화물이 다른데 같은 판정을
    // 돌려주면 혼재 판정이 틀린 답을 내게 된다. 안 맞으면 판단 보류로 흘린다.
    if (path.endsWith('/safety/assess')) {
      const byInput = snap['/api/v1/safety/assess'] || {};
      try {
        const b = JSON.parse(init?.body ?? '{}');
        const id = (c) => c?.cas_no || c?.chem_id;
        const parts = (b.adjacent_cargos || [])
          .map((a) => `${a.berth_name}:${id(a.cargo)}`).sort();
        const key = `${id(b.target_cargo)}|${parts.join(',')}`;
        if (byInput[key]) return jsonResponse(byInput[key]);
      } catch { /* 아래 503 */ }
      return jsonResponse(
        { detail: '스냅샷 배포본에 이 조합의 판정이 없습니다 - 실시간 서버가 필요합니다' },
        503,
      );
    }

    // 대체 선석 제안은 body 의 name_hint(선명)로 갈라 저장해 둔다
    // ([2026-09-27] /scheduling/candidates → /scheduling/alternatives. 옛 스냅샷에는 없다 — 재생성 필요)
    if (path.endsWith('/scheduling/alternatives')) {
      const byName = snap['/api/v1/scheduling/alternatives'] || {};
      let name = null;
      try { name = JSON.parse(init?.body ?? '{}').vessel?.name_hint; } catch { /* 아래 503 */ }
      if (name && byName[name]) return jsonResponse(byName[name]);
      return jsonResponse(
        { detail: '스냅샷 배포본에 이 선박의 후보가 없습니다 - 실시간 서버가 필요합니다' },
        503,
      );
    }

    if (snap[path]) return jsonResponse(snap[path]);

    return jsonResponse(
      { detail: '스냅샷 배포본입니다 - 이 기능은 실시간 서버가 필요합니다' },
      503,
    );
  };
}
