/**
 * HermesMark —— Hermes harness 的身份 mark。
 *
 * Hermes 没有对外品牌 glyph;这里用细描边翼形,与 PiMark / CodexMark 的
 * 视觉重量对齐。只使用 currentColor,跟随主题 / 状态染色。
 */

interface HermesMarkProps {
  size?: number;
  className?: string;
}

export function HermesMark({ size = 14, className }: HermesMarkProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden
      data-ink-icon=""
    >
      <g
        fill="none"
        stroke="currentColor"
        strokeWidth={2.2}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {/* 双翼 */}
        <path d="M3.2 8.4c3.4.2 6 1.9 7.6 4.6" />
        <path d="M20.8 8.4c-3.4.2-6 1.9-7.6 4.6" />
        {/* 杖身与翼下短羽 */}
        <path d="M12 6.2v12.2" />
        <path d="M6.2 12.4c2.6.1 4.6 1.4 5.8 3.4" />
        <path d="M17.8 12.4c-2.6.1-4.6 1.4-5.8 3.4" />
      </g>
    </svg>
  );
}
