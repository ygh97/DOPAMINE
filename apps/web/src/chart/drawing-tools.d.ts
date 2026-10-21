import type { Chart } from "klinecharts";

export interface DrawingController {
  /** 현재 종목의 그림을 보관(localStorage 포함)하고 차트에서 지운다. factor = 지금의 누적 주식병합 배수 */
  save(key: string, factor?: number): void;
  /** 보관한 그림을 다시 그린다. 저장 뒤 병합이 있었으면 가격 좌표를 factor/저장 당시 배수만큼 옮긴다 */
  load(key: string, factor?: number): void;
  /** 대표 도구 예시를 현재 데이터 위에 그린다 */
  demo(): void;
  /** 모든 종목의 그림과 저장분을 지운다 (새 시즌) */
  clearAll(): void;
}
export function register(): void;
export function mount(chart: Chart, bar: HTMLElement, pop: HTMLElement): DrawingController;
export function alpha(hex: string, a: number): string;
