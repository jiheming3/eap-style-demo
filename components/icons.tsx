import type { CSSProperties } from "react";

const paths: Record<string, React.ReactNode> = {
  plus: <path d="M12 5v14M5 12h14" />,
  arrow: <><path d="m12 19 0-14m-6 6 6-6 6 6" /></>,
  chevron: <path d="m9 5 7 7-7 7" />,
  down: <path d="m6 9 6 6 6-6" />,
  close: <path d="m6 6 12 12M6 18 18 6" />,
  menu: <path d="M4 6h16M4 12h16M4 18h16" />,
  message: <path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5Z" />,
  heart: <path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z" />,
  leaf: <><path d="M20 4c-8-2-16 2-16 9a7 7 0 0 0 7 7c7 0 11-8 9-16Z" /><path d="M4 20 15 9M9 15h5" /></>,
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M2 12h2m16 0h2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>,
  work: <><rect x="3" y="7" width="18" height="14" rx="3" /><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 12a23 23 0 0 0 18 0M12 12v4" /></>,
  calendar: <><rect x="3" y="5" width="18" height="16" rx="3" /><path d="M16 3v4M8 3v4M3 11h18m-13 5h2m4 0h2" /></>,
  headphones: <><path d="M3 14v-3a9 9 0 0 1 18 0v3" /><rect x="3" y="12" width="4" height="8" rx="2" /><rect x="17" y="12" width="4" height="8" rx="2" /></>,
  cloud: <path d="M7 19a5 5 0 1 1 .8-9.9A7 7 0 0 1 21 12a3.5 3.5 0 0 1-2 7H7Z" />,
  layers: <><path d="m12 3 10 5-10 5L2 8l10-5ZM2 12l10 5 10-5M2 16l10 5 10-5" /></>,
  shield: <><path d="M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6l-8-3Z" /><path d="m9 12 2 2 4-4" /></>,
  refresh: <><path d="M20 7v5h-5M4 17v-5h5" /><path d="M6.1 7a7 7 0 0 1 11.5-2L20 8M4 16l2.4 3A7 7 0 0 0 17.9 17" /></>,
  lock: <><rect x="4" y="10" width="16" height="11" rx="3" /><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3" /></>,
  settings: <><path d="m12 2 2 3 3-.2.8 3 2.7 1.7-1.3 2.8 1.3 2.7-2.7 1.8-.8 3-3-.3-2 2.5-2-2.5-3 .3-.8-3L3.5 15l1.3-2.7L3.5 9.5 6.2 8l.8-3 3 .2L12 2Z" /><circle cx="12" cy="12" r="3" /></>,
  check: <path d="m5 12 4 4L19 6" />,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7h.01" /></>,
  download: <><path d="M12 3v12m-4-4 4 4 4-4M4 16v4h16v-4" /></>,
  copy: <><rect x="8" y="8" width="12" height="13" rx="2" /><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" /></>,
  like: <><path d="M7 10H4v11h3V10Zm0 0 5-8c2 0 3 2 2 5l-1 3h6c2 0 2 2 1 4l-2 6H7V10Z" /></>,
  edit: <><path d="m15 4 5 5M3 21l5-1L21 7a2.1 2.1 0 0 0-5-5L3 15v6Z" /></>,
  book: <><path d="M12 5c-3-2-6-2-10-1v15c4-1 7-1 10 1 3-2 6-2 10-1V4c-4-1-7-1-10 1ZM12 5v15" /></>,
  stop: <rect x="6" y="6" width="12" height="12" rx="2" />,
  external: <><path d="M14 3h7v7m0-7L10 14M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5" /></>,
};

export function Icon({ name, size = 20, className, style }: { name: string; size?: number; className?: string; style?: CSSProperties }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className} style={style}>{paths[name] ?? paths.message}</svg>;
}

export function Mark({ small = false }: { small?: boolean }) {
  return <span className={`brand-mark ${small ? "small" : ""}`} aria-hidden="true"><svg viewBox="0 0 36 36" fill="none"><path d="M9 21c0-8 8-14 17-12 2 9-4 17-12 17H9v-5Z" fill="currentColor" opacity=".95" /><path d="m10 26 10-11" stroke="var(--paper)" strokeWidth="1.8" strokeLinecap="round" /><circle cx="9" cy="9" r="3" fill="var(--accent)" /></svg></span>;
}
