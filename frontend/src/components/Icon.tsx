import type { SVGProps } from 'react';

const paths = {
  pin: <><path d="m9 3 6 0-1 6 4 4v2H6v-2l4-4Z"/><path d="M12 15v6"/></>,
  settings: <><path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="15" cy="17" r="3"/></>,
  play: <path d="m9 5 11 7-11 7Z"/>,
  pause: <><path d="M8 5v14M16 5v14"/></>,
  album: <><rect x="3" y="3" width="18" height="18" rx="5"/><path d="m4 16 5-5 4 4 3-3 5 5"/><circle cx="15.5" cy="8" r="1"/></>,
  star: <path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9Z"/>,
  folder: <path d="M3 7V5h6l2 2h10v12H3Z"/>,
  search: <><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/></>,
  palette: <><path d="M12 3a9 9 0 1 0 0 18h1a2 2 0 0 0 0-4h-1a2 2 0 0 1 0-4h3a6 6 0 0 0 0-10Z"/><path d="M7 10h.01M10 6h.01M15 6h.01M18 10h.01"/></>,
  refresh: <><path d="M20 7v5h-5M4 17v-5h5"/><path d="M5 8a7 7 0 0 1 12-3l3 3M4 16l3 3a7 7 0 0 0 12-3"/></>,
  close: <path d="m6 6 12 12M6 18 18 6"/>,
  left: <path d="m14 6-6 6 6 6"/>,
  right: <path d="m10 6 6 6-6 6"/>,
  check: <path d="m5 12 4 4 10-10"/>,
  shuffle: <><path d="M3 6h3c4 0 6 12 10 12h5M3 18h3c1.5 0 2.8-1.7 4-4M14 8c.8-1.2 1.5-2 2-2h5M18 3l3 3-3 3M18 15l3 3-3 3"/></>,
  external: <><path d="M14 3h7v7M21 3l-11 11"/><path d="M10 3H3v18h18v-7"/></>,
  download: <><path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/></>,
  globe: <><circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18"/></>,
  calendar: <><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M7 3v4M17 3v4M3 11h18"/></>,
  edit: <><path d="m15 4 5 5-11 11-6 1 1-6Z"/><path d="m12 7 5 5"/></>,
  github: <><path d="M9 20c-4 1-4-2-6-2M15 22v-4c0-1 .2-2-1-3 4 0 7-2 7-6a5 5 0 0 0-1-3c0-1 0-2-.5-3-2 0-3 1-4 2a13 13 0 0 0-7 0C7 4 6 3 4 3c-.5 1-.5 2-.5 3A5 5 0 0 0 2 9c0 4 3 6 7 6-1 1-1 2-1 3v4"/></>,
  info: <><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/></>,
};
export type IconName = keyof typeof paths;
export function Icon({ name, ...props }: SVGProps<SVGSVGElement> & { name: IconName }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>{paths[name]}</svg>;
}
