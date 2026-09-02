/**
 * Claude API 기반 Summarizer — 재주문 리포트 표를 2~3문장으로 요약하는 문구만 만든다.
 * LLM 경계(CLAUDE.md 가드레일 3): 품목·수량·금액은 전부 결정론 계산 결과(ReorderReport)에서
 * 오고, 이 모듈은 문자열 하나만 반환한다 — 호출자가 그 문자열에서 숫자를 파싱해 로직에 쓰면 안 된다.
 * 프롬프트에 "수치를 새로 만들지 않는다, 제공된 표의 사실만 쓴다"를 명시한다.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { ReorderReport, Summarizer } from "../core/types.js";

const DEFAULT_MODEL = "claude-opus-5";
// 2~3문장짜리 짧은 요약이라 넉넉히 잡아도 작다 — 출력이 잘려 재시도해야 하는 상황을 피할 정도로만.
const MAX_TOKENS = 600;

const SYSTEM_PROMPT = `당신은 리테일 매장 오너에게 보낼 재주문 제안 이메일의 요약 문구를 씁니다.

반드시 지켜야 할 규칙:
1. 정확히 2~3문장으로만 씁니다.
2. 아래 사용자 메시지로 주어진 표에 있는 사실(매장명, 품목명, 건수 등)만 언급합니다.
3. 수치(수량·금액·일수·건수 등)를 스스로 계산하거나 새로 만들어내지 않습니다 — 표에 이미
   있는 값을 그대로 인용할 때만 언급하고, 표에 없는 숫자는 절대 언급하지 않습니다.
4. 매장 오너가 바로 읽을 수 있는 자연스러운 영어 또는 타글리시 문장으로 씁니다.
5. 문장 외의 다른 형식(제목, 목록, 코드블록 등)은 쓰지 않습니다.`;

function formatCover(daysOfCover: number | null): string {
  return daysOfCover === null ? "∞" : daysOfCover.toFixed(1);
}

function buildUserPrompt(report: ReorderReport): string {
  const lines: string[] = [
    `생성 시각: ${report.generatedAt.toISOString()} (기준 타임존: ${report.timezone})`,
  ];
  if (report.dataLastSyncedAt) {
    lines.push(`마지막 동기화: ${report.dataLastSyncedAt.toISOString()}`);
  } else {
    lines.push("마지막 동기화: 정보 없음");
  }

  for (const store of report.stores) {
    lines.push(`\n[매장: ${store.storeName}] (품목 ${store.items.length}건)`);
    for (const item of store.items) {
      lines.push(
        `- ${item.name}: 현재고 ${item.inStock}, 일평균판매 ${item.avgDailySales.toFixed(2)}, ` +
          `재고커버 ${formatCover(item.daysOfCover)}일, 제안수량 ${item.reorderQty}`,
      );
    }
  }

  if (report.warnings.length > 0) {
    lines.push(`\n주의사항: ${report.warnings.join("; ")}`);
  }

  lines.push("\n위 표의 사실만 근거로 2~3문장 요약을 작성하세요.");
  return lines.join("\n");
}

export interface ClaudeSummarizerOptions {
  /** 기본값: 환경변수 ANTHROPIC_API_KEY */
  apiKey?: string;
  /** 테스트에서 mock fetch를 주입하기 위한 훅. Anthropic SDK의 커스텀 fetch 옵션에 그대로 전달한다. */
  fetchImpl?: typeof fetch;
  model?: string;
}

export function createClaudeSummarizer(options: ClaudeSummarizerOptions = {}): Summarizer {
  const apiKey = options.apiKey ?? process.env["ANTHROPIC_API_KEY"];
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY가 없습니다. Anthropic 콘솔에서 발급해 .env에 추가하세요.");
  }
  const model = options.model ?? DEFAULT_MODEL;
  const client = new Anthropic({
    apiKey,
    ...(options.fetchImpl !== undefined ? { fetch: options.fetchImpl } : {}),
  });

  return {
    async summarize(input: ReorderReport): Promise<string> {
      const response = await client.messages.create({
        model,
        max_tokens: MAX_TOKENS,
        system: SYSTEM_PROMPT,
        // 표를 문장으로 옮기는 단순 작업이라 낮은 effort로 비용·지연을 줄인다.
        output_config: { effort: "low" },
        messages: [{ role: "user", content: buildUserPrompt(input) }],
      });

      const textBlock = response.content.find(
        (block): block is Anthropic.TextBlock => block.type === "text",
      );
      if (!textBlock) {
        throw new Error(
          "Claude 응답에 텍스트 블록이 없습니다 (예상치 못한 응답 형식 — stop_reason 확인 필요).",
        );
      }
      return textBlock.text.trim();
    },
  };
}
