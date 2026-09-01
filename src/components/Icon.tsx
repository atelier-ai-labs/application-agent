import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function baseProps(size: number, props: IconProps) {
  const { size: _size, ...rest } = props;
  return {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.7,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    ...rest,
  };
}

export function ArrowUpRight({ size = 16, ...props }: IconProps) {
  return (
    <svg {...baseProps(size, props)} aria-hidden="true">
      <path d="M7 17 17 7" />
      <path d="M7 7h10v10" />
    </svg>
  );
}

export function ArrowLeft({ size = 16, ...props }: IconProps) {
  return (
    <svg {...baseProps(size, props)} aria-hidden="true">
      <path d="m15 18-6-6 6-6" />
    </svg>
  );
}

export function ExternalLink({ size = 15, ...props }: IconProps) {
  return (
    <svg {...baseProps(size, props)} aria-hidden="true">
      <path d="M14 4h6v6" />
      <path d="m20 4-9 9" />
      <path d="M18 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5" />
    </svg>
  );
}

export function Database({ size = 16, ...props }: IconProps) {
  return (
    <svg {...baseProps(size, props)} aria-hidden="true">
      <ellipse cx="12" cy="5" rx="7" ry="3" />
      <path d="M5 5v7c0 1.7 3.1 3 7 3s7-1.3 7-3V5" />
      <path d="M5 12v7c0 1.7 3.1 3 7 3s7-1.3 7-3v-7" />
    </svg>
  );
}

export function Activity({ size = 16, ...props }: IconProps) {
  return (
    <svg {...baseProps(size, props)} aria-hidden="true">
      <path d="M3 12h4l2-7 4 14 2-7h6" />
    </svg>
  );
}

export function Layers({ size = 16, ...props }: IconProps) {
  return (
    <svg {...baseProps(size, props)} aria-hidden="true">
      <path d="m12 3 9 5-9 5-9-5 9-5Z" />
      <path d="m3 12 9 5 9-5" />
      <path d="m3 16 9 5 9-5" />
    </svg>
  );
}

export function Menu({ size = 20, ...props }: IconProps) {
  return (
    <svg {...baseProps(size, props)} aria-hidden="true">
      <path d="M4 7h16M4 12h16M4 17h16" />
    </svg>
  );
}

export function Check({ size = 14, ...props }: IconProps) {
  return (
    <svg {...baseProps(size, props)} aria-hidden="true">
      <path d="m5 12 4 4L19 6" />
    </svg>
  );
}

export function Minus({ size = 14, ...props }: IconProps) {
  return (
    <svg {...baseProps(size, props)} aria-hidden="true">
      <path d="M5 12h14" />
    </svg>
  );
}
