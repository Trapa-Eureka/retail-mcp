# WORKFLOW — 이 레포를 굴리는 AI-native 규칙

기반: Clare Liguori (AWS), "From AI-Assisted to AI-Native: Building a Frontier Development Team"
(https://youtu.be/Ry0WHNxDbYA · AWS 블로그: https://aws.amazon.com/blogs/machine-learning/how-frontier-teams-are-reinventing-ai-native-development/)
운영 원칙은 sheet_mcp의 WORKFLOW와 동일하다. 여기서는 공통 규칙 요약 + **retail-mcp 특이사항**만 적는다.

## 0. 역할 정의 (프론티어 3행동)

| 행동 | 이 레포에서 |
|---|---|
| Hands-off Coding (1~2%) | Jin은 SPEC/DESIGN 수정·리뷰·승인만. 구현은 에이전트 |
| Infrequent Interaction | 태스크마다 기계 판정 완료 기준 → 세션 중 개입 없이 완주 |
| Minimized Idle Time | T1 이후 레인 A~D를 git worktree로 병렬. sheet_mcp와 **레포 간 병렬**도 가능 (서로 독립) |

## 1. 습관 5개 → 규칙 (공통 요약)

1. **Agent Context** — 부족지식은 CLAUDE.md/docs에만 존재한다. 격주 프루닝 + 로그.
2. **Slow Down to Speed Up** — T0~T1에 도구·타입·스키마·에러 메시지 투자. strict TS가 가장 싼 피드백 루프.
3. **Feed, Don't Babysit** — 배정은 TASKS 템플릿 1회. 자기 검증 = `npm run check` + 명시된 테스트.
   ```bash
   git worktree add ../retail-mcp-t5 -b t5 && cd ../retail-mcp-t5 && claude
   ```
4. **Explicit Intent** — 코드보다 문서 diff 먼저. 지표 수식 변경은 반드시 SPEC §2 + DESIGN §3 동시 수정 후 태스크화.
5. **Shift Left** — 로컬 결정론 목: POS=픽스처, DB=**PGlite**, 발송·LLM=목. 라이브 의존은 게이트에 못 들어온다.

## 2. retail-mcp 특이사항

- **수식이 곧 제품**: metrics 골든 케이스(TESTING §3)는 손계산 값이 진실이다. 에이전트가 "테스트를 수식에 맞추는" 방향의 수정을 하면 리뷰에서 반려한다 — 수정 방향은 항상 코드→문서 수식.
- **LLM 경계 감시**: 리뷰 시 Summarizer 출력이 로직·수치에 흘러들어가는 코드가 없는지 확인 (CLAUDE.md 가드레일 3).
- **두 진입점 일치성**: MCP 도구와 에이전트 리포트의 수치 일치 테스트(TESTING §4)는 회귀의 최전선 — 삭제·완화 금지.

## 3. 일일 운영 루틴

1. 착수 가능 태스크 확인 → 레인별 worktree 배정 (sheet_mcp 태스크와 섞어 배정 가능)
2. 실행 중 개입하지 않는다 — 그 시간에 v0.2 문서를 다듬거나 리뷰
3. 완료 보고 → `npm run check` 재실행 → diff 리뷰 → 머지 → 상태 갱신
4. 격주: CLAUDE.md 프루닝, TASKS 정리

## 4. 자율성의 한계선 (사람이 잡는 것)

- `SEND_MODE=live` 전환과 최초 실발송 (`--confirm`)
- 프로덕션 `DATABASE_URL`에 대한 `npm run migrate` 실행
- 지표 수식·기본값(리드타임, 목표커버 등) 변경 승인
- 파일럿 매장 선정과 Loyverse 토큰·시크릿 관리

## 5. 문서 일관성 게이트

태스크 착수 전 담당 에이전트는 해당 TASK뿐 아니라 연결된 SPEC·DESIGN·TESTING 절을 대조한다. 아래 변경은 한 파일만 고치면 완료가 아니다.

| 변경 내용 | 함께 갱신할 문서 |
|---|---|
| 지표 수식·기본값·기간 경계 | SPEC §2/§9, DESIGN §3/§11, TESTING 골든 케이스 |
| DB 스키마·동기화 커서 | DESIGN §2/§5/§11, TASKS의 해당 완료 기준, migration 테스트 |
| MCP 입력·출력·권한 | DESIGN §6/§11, TESTING MCP·보안 체크리스트, README 운영 안내 |
| 에이전트 발송·로그 상태 | DESIGN §7/§11, TESTING 에이전트 체크리스트, CLAUDE 가드레일 |

리뷰 순서는 `문서 diff → 마이그레이션/API 계약 → 순수 코어 → 어댑터·진입점 → 테스트 결과`다. 완료 보고에는 실행한 명령, 통과/실패 수, 실행하지 못한 수동 검증을 구분해 적는다. 문서의 날짜·상태·태스크 완료 표시는 실제 코드와 검증 결과가 일치할 때만 갱신한다.

## 6. 운영 변경 체크

- 운영 DB 마이그레이션 전 백업·복구 절차와 적용 대상 DB를 사람이 확인한다.
- live 발송 전 dry-run 산출물, 수신자, 발신 도메인, 마지막 동기화 시각, 동일 `run_id` 발송 이력을 확인한다.
- 장애 시 마지막 성공 데이터를 조회 가능하게 유지하되 stale 경고를 제거하지 않는다. 재시도는 멱등성을 확인한 뒤 수행한다.
- 시크릿이 diff·로그·테스트 픽스처에 노출되면 해당 시크릿을 즉시 폐기·재발급하고 커밋 이력 정리를 사람에게 에스컬레이션한다.
