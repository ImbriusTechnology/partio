// A few line icons drawn inline (no icon library needed). They take the text colour.
import type { SVGProps } from 'react';

type P = SVGProps<SVGSVGElement> & { size?: number };
const base = (size: number, rest: SVGProps<SVGSVGElement>) => ({
  width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8,
  strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true, ...rest,
});

export const IconParts = ({ size = 16, ...r }: P) => (
  <svg {...base(size, r)}><rect x="7" y="7" width="10" height="10" rx="1.5" /><path d="M10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4" /></svg>
);
export const IconLocations = ({ size = 16, ...r }: P) => (
  <svg {...base(size, r)}><rect x="3" y="4" width="18" height="7" rx="1.5" /><rect x="3" y="13" width="18" height="7" rx="1.5" /><path d="M10 7.5h4M10 16.5h4" /></svg>
);
export const IconAssemblies = ({ size = 16, ...r }: P) => (
  <svg {...base(size, r)}><path d="M12 3l9 5-9 5-9-5 9-5z" /><path d="M3 13l9 5 9-5" /></svg>
);
export const IconSettings = ({ size = 16, ...r }: P) => (
  <svg {...base(size, r)}><path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0" /><circle cx="16" cy="6" r="2" /><circle cx="10" cy="12" r="2" /><circle cx="18" cy="18" r="2" /></svg>
);
export const IconSearch = ({ size = 14, ...r }: P) => (
  <svg {...base(size, r)}><circle cx="11" cy="11" r="6.5" /><path d="M16 16l4.5 4.5" /></svg>
);
export const IconCopy = ({ size = 13, ...r }: P) => (
  <svg {...base(size, r)}><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H8" /></svg>
);
export const IconChevron = ({ size = 12, open, ...r }: P & { open?: boolean }) => (
  <svg {...base(size, r)} style={{ transition: 'transform 120ms', transform: open ? 'rotate(90deg)' : 'none' }}><path d="M9 6l6 6-6 6" /></svg>
);
export const IconPlus = ({ size = 14, ...r }: P) => (
  <svg {...base(size, r)}><path d="M12 5v14M5 12h14" /></svg>
);
export const IconCart = ({ size = 16, ...r }: P) => (
  <svg {...base(size, r)}><path d="M3 4h2.5l2.2 10.2a1.5 1.5 0 0 0 1.5 1.2h8.3a1.5 1.5 0 0 0 1.5-1.1L21 8H6.3" /><circle cx="10" cy="19.5" r="1.3" /><circle cx="17" cy="19.5" r="1.3" /></svg>
);
