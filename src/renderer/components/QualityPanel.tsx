/**
 * 设置页「质量」分组：把本机评测集（LLM-as-judge）的汇总摊开给用户看。
 *
 * 展示口径（PRD P5）：分数只在这里出现，对话界面只有图标，没有任何数字。
 * 所以这个面板必须自己把话说全 —— 总分、四维、封顶提示、被踩样本。
 *
 * 硬约束：
 * - 不写任何字面颜色，只用 theme.css 里的语义类（bg-surface / text-muted / text-danger …）
 * - 日期一律按本地时区手写拼装（不借 ISO 字符串切日期：那是 UTC 口径，界面会差一天）
 * - 不做任何请求：数据来自 store 的 judgeSummary，由设置弹层在切到本分组时拉取；
 *   这里另给一个「刷新」按钮兜底（弹层重开时 section 可能已停在「质量」，不会触发切换）
 */
import { Button, Label } from '@heroui/react';
import { useState, type ReactNode } from 'react';
import type { JudgeCaseSummary, JudgeScores } from '../../shared/types';
import { JUDGE_SUMMARY_DAYS, useAppStore } from '../store/useAppStore';

/** 维度的展示顺序（与 rubric 的表格顺序一致，不随对象键顺序漂移） */
const DIMENSION_ORDER: Array<keyof JudgeScores> = [
  'relevance',
  'faithfulness',
  'completeness',
  'clarity',
];

/** 维度中文名 */
const DIMENSION_LABELS: Record<keyof JudgeScores, string> = {
  relevance: '相关性',
  faithfulness: '忠实度',
  completeness: '完整性',
  clarity: '表达质量',
};

/** 分数展示：保留 1 位小数；无数据用长横线占位，不写 0（0 分不存在，会误导） */
function formatScore(value: number | null | undefined): string {
  return typeof value === 'number' ? value.toFixed(1) : '—';
}

/**
 * 日期展示：月-日。
 * 刻意不借 ISO 字符串切日期 —— 它按 UTC 切，东八区晚上 8 点后
 * 会显示成前一天，与用户日历对不上。这里按本地时区自己拼。
 */
function formatDay(timestamp: number): string {
  const date = new Date(timestamp);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${month}-${day}`;
}

/** 被踩样本的一行：提问 + 分数 + 最弱维度 + 日期 */
function DownSampleRow({ item }: { item: JudgeCaseSummary }): ReactNode {
  const weakest = item.weakest;
  return (
    <div className="flex min-w-0 items-baseline gap-2 border-t border-line px-2 py-1.5 text-[12px] first:border-t-0">
      <span className="min-w-0 flex-1 truncate text-fg" title={item.question}>
        {item.question}
      </span>
      {item.overall !== undefined ? (
        <span className="shrink-0 text-muted">{`${formatScore(item.overall)} 分`}</span>
      ) : (
        <span className="shrink-0 text-muted">{item.error !== undefined ? '未评成功' : '未评测'}</span>
      )}
      {weakest !== undefined ? (
        <span className="shrink-0 text-muted">{DIMENSION_LABELS[weakest]}</span>
      ) : null}
      <span className="shrink-0 text-muted">{formatDay(item.createdAt)}</span>
    </div>
  );
}

export default function QualityPanel() {
  const summary = useAppStore((state) => state.judgeSummary);
  const refreshJudgeSummary = useAppStore((state) => state.refreshJudgeSummary);
  // 被踩样本默认折叠：多数时候用户只想看概览，需要回看时再展开
  const [samplesOpen, setSamplesOpen] = useState(false);

  const downSamples = summary?.downSamples ?? [];
  // 计数用主进程给的真实总数（downSamples 只是最近的若干条，上限在主进程侧）
  const downCount = summary?.downCount ?? 0;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <div className="mb-1 flex items-center justify-between">
          <Label className="text-[12px] text-muted">评测集概览</Label>
          <Button size="sm" variant="ghost" onPress={() => void refreshJudgeSummary()}>
            刷新
          </Button>
        </div>

        {summary === null ? (
          <p className="text-[12px] text-muted">读取中…</p>
        ) : summary.total === 0 ? (
          <p className="text-[12px] text-muted">
            还没有评测样本。在对话里点回答下方的星形图标即可评测这条回答；给回答点「没帮助」也会把它归档成样本。
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {/* 汇总行：样本量 / 已评测 / 近 N 天 / 均分 */}
            <p className="text-[13px] text-fg">
              {`共 ${summary.total} 条样本 · 已评测 ${summary.evaluated} 条 · 近 ${JUDGE_SUMMARY_DAYS} 天新增 ${summary.window30d} 条 · 均分 ${formatScore(summary.avgOverall)}`}
            </p>

            {/* 维度行：四维均值，某一维无数据时显示占位符 */}
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              {DIMENSION_ORDER.map((dim) => (
                <span key={dim} className="text-[12px] text-muted">
                  {DIMENSION_LABELS[dim]}
                  <span className="ml-1 text-fg">{formatScore(summary.dims[dim])}</span>
                </span>
              ))}
            </div>

            {/* 封顶提示：忠实度 ≤ 2 的硬否决触发次数，是「模型在编」的最强信号 */}
            {summary.cappedCount > 0 ? (
              <p className="rounded-[6px] border border-line bg-surface-secondary px-3 py-2 text-[12px] text-fg">
                {`有 ${summary.cappedCount} 条样本触发忠实度封顶：忠实度 ≤ 2 时总分被压到 2 分，`}
                <span className="text-danger">这类回答很可能在编造不存在的信息</span>
                {'，建议逐条回看。'}
              </p>
            ) : null}

            {/* 被踩样本：可展开的回看列表 */}
            {downCount > 0 ? (
              <div className="min-w-0">
                <button
                  type="button"
                  className="flex w-full cursor-pointer items-center gap-1.5 rounded-[6px] px-1 py-1 text-left text-[12px] text-muted hover:text-fg"
                  aria-expanded={samplesOpen}
                  onClick={() => setSamplesOpen(!samplesOpen)}
                >
                  <span className="shrink-0">{samplesOpen ? '▾' : '▸'}</span>
                  <span className="shrink-0">{`被踩的样本（${downCount}）`}</span>
                </button>
                {samplesOpen ? (
                  <>
                    {/* 总数超过样本条数时说明「只展示最近几条」，不硬写上限（上限在主进程） */}
                    {downCount > downSamples.length ? (
                      <p className="mt-1 text-[11px] text-muted">
                        {`共 ${downCount} 条，这里只展示最近的 ${downSamples.length} 条`}
                      </p>
                    ) : null}
                    <div className="mt-1 min-w-0 rounded-[6px] border border-line">
                      {downSamples.map((item) => (
                        <DownSampleRow key={item.id} item={item} />
                      ))}
                    </div>
                  </>
                ) : null}
              </div>
            ) : null}
          </div>
        )}
      </div>

      <p className="text-[12px] text-muted">
        评测用当前配置的模型充当裁判，对每条回答按相关性、忠实度、完整性、表达质量各打 1–5 分，
        取四维均值为总分；忠实度 ≤ 2 时总分封顶为 2 分。分数只出现在这里，不会显示在对话界面。
      </p>
    </div>
  );
}
