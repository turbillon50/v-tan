type IP = { size?: number; className?: string; color?: string };
const s = (size = 18) => ({ width: size, height: size, viewBox: "0 0 24 24", fill: "none" as const });

export const UpArrow = ({ size = 18, className = "", color = "currentColor" }: IP) => (
  <svg className={className} {...s(size)}>
    <path d="M12 4L20 14H4L12 4Z" fill={color} />
    <rect x="10" y="14" width="4" height="6" rx="1" fill={color} />
  </svg>
);

export const DownArrow = ({ size = 18, className = "", color = "currentColor" }: IP) => (
  <svg className={className} {...s(size)}>
    <path d="M12 20L4 10H20L12 20Z" fill={color} />
    <rect x="10" y="4" width="4" height="6" rx="1" fill={color} />
  </svg>
);

export const NeutralLine = ({ size = 18, className = "" }: IP) => (
  <svg className={className} {...s(size)}>
    <rect x="3" y="11" width="18" height="2.5" rx="1.25" fill="currentColor" />
  </svg>
);

export const PlayBtn = ({ size = 18, className = "", color = "currentColor" }: IP) => (
  <svg className={className} {...s(size)}>
    <path d="M7 4L20 12L7 20V4Z" fill={color} />
  </svg>
);

export const StopBtn = ({ size = 18, className = "", color = "currentColor" }: IP) => (
  <svg className={className} {...s(size)}>
    <rect x="4" y="4" width="16" height="16" rx="3" fill={color} />
  </svg>
);

export const RefreshIcon = ({ size = 18, className = "" }: IP) => (
  <svg className={className} {...s(size)} stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
    <path d="M3 3v5h5" fill="none" />
  </svg>
);

export const ClockIcon = ({ size = 18, className = "" }: IP) => (
  <svg className={className} {...s(size)}>
    <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" />
    <path d="M12 7v5l3 2.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
  </svg>
);

export const GlobeIcon = ({ size = 18, className = "" }: IP) => (
  <svg className={className} {...s(size)} stroke="currentColor" strokeWidth="1.8">
    <circle cx="12" cy="12" r="9" />
    <path d="M2 12h20M12 3c-2.5 3-4 5.8-4 9s1.5 6 4 9M12 3c2.5 3 4 5.8 4 9s-1.5 6-4 9" />
  </svg>
);

export const TimerIcon = ({ size = 18, className = "" }: IP) => (
  <svg className={className} {...s(size)}>
    <circle cx="12" cy="14" r="8" stroke="currentColor" strokeWidth="2" />
    <path d="M12 10v4l2.5 2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    <path d="M9 2h6M12 2v2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
  </svg>
);

export const ActivityIcon = ({ size = 18, className = "" }: IP) => (
  <svg className={className} {...s(size)} stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="2,12 6,12 8,5 12,19 15,9 17,12 22,12" />
  </svg>
);

export const AlertIcon = ({ size = 18, className = "" }: IP) => (
  <svg className={className} {...s(size)}>
    <path d="M12 2L2 21h20L12 2Z" fill="currentColor" opacity="0.9" />
    <rect x="11" y="9" width="2" height="6" rx="1" fill="white" />
    <circle cx="12" cy="17.5" r="1" fill="white" />
  </svg>
);

export const ZapIcon = ({ size = 18, className = "", color = "currentColor" }: IP) => (
  <svg className={className} {...s(size)}>
    <path d="M13 2L4 14h7l-1 8 9-12h-7l2-8Z" fill={color} />
  </svg>
);

export const ShieldIcon = ({ size = 18, className = "" }: IP) => (
  <svg className={className} {...s(size)}>
    <path d="M12 2L4 5v7c0 5 3.5 9 8 10 4.5-1 8-5 8-10V5L12 2Z" fill="currentColor" opacity="0.85" />
    <path d="M9 12l2 2 4-4" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const TargetIcon = ({ size = 18, className = "" }: IP) => (
  <svg className={className} {...s(size)} stroke="currentColor" strokeWidth="1.8">
    <circle cx="12" cy="12" r="9" />
    <circle cx="12" cy="12" r="5" />
    <circle cx="12" cy="12" r="1.5" fill="currentColor" />
    <line x1="12" y1="1" x2="12" y2="4" strokeWidth="2" strokeLinecap="round" />
    <line x1="12" y1="20" x2="12" y2="23" strokeWidth="2" strokeLinecap="round" />
    <line x1="1" y1="12" x2="4" y2="12" strokeWidth="2" strokeLinecap="round" />
    <line x1="20" y1="12" x2="23" y2="12" strokeWidth="2" strokeLinecap="round" />
  </svg>
);

export const StarIcon = ({ size = 18, className = "", color = "currentColor" }: IP) => (
  <svg className={className} {...s(size)}>
    <path d="M12 2l2.9 6.1 6.6.6-4.9 4.5 1.5 6.6L12 17l-6.1 2.8 1.5-6.6L2.5 8.7l6.6-.6L12 2Z" fill={color} />
  </svg>
);

export const DollarIcon = ({ size = 18, className = "" }: IP) => (
  <svg className={className} {...s(size)} stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
    <line x1="12" y1="1" x2="12" y2="23" />
    <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
  </svg>
);

export const CopyIcon = ({ size = 18, className = "" }: IP) => (
  <svg className={className} {...s(size)} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
    <rect x="9" y="9" width="12" height="12" rx="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </svg>
);

export const BellIcon = ({ size = 18, className = "" }: IP) => (
  <svg className={className} {...s(size)}>
    <path d="M5 10a7 7 0 1 1 14 0v5l2 2H3l2-2v-5Z" fill="currentColor" opacity="0.85" />
    <path d="M10 21a2 2 0 0 0 4 0" stroke="currentColor" strokeWidth="2" fill="none" />
  </svg>
);

export const SendIcon = ({ size = 18, className = "" }: IP) => (
  <svg className={className} {...s(size)}>
    <path d="M2 12L22 2L12 22L10 14L2 12Z" fill="currentColor" />
  </svg>
);

export const PhoneIcon = ({ size = 18, className = "" }: IP) => (
  <svg className={className} {...s(size)} stroke="currentColor" strokeWidth="1.8">
    <rect x="5" y="2" width="14" height="20" rx="3" />
    <line x1="12" y1="18" x2="12" y2="18.5" strokeWidth="2.5" strokeLinecap="round" />
  </svg>
);

export const LinkIcon = ({ size = 18, className = "" }: IP) => (
  <svg className={className} {...s(size)} stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    <polyline points="15 3 21 3 21 9" />
    <line x1="10" y1="14" x2="21" y2="3" />
  </svg>
);

export const InfoIcon = ({ size = 18, className = "" }: IP) => (
  <svg className={className} {...s(size)}>
    <circle cx="12" cy="12" r="10" fill="currentColor" opacity="0.8" />
    <line x1="12" y1="8" x2="12" y2="8.5" stroke="white" strokeWidth="2.5" strokeLinecap="round" />
    <line x1="12" y1="11" x2="12" y2="16" stroke="white" strokeWidth="2" strokeLinecap="round" />
  </svg>
);

export const CheckIcon = ({ size = 18, className = "" }: IP) => (
  <svg className={className} {...s(size)}>
    <circle cx="12" cy="12" r="10" fill="currentColor" opacity="0.85" />
    <path d="M7.5 12.5l3 3 6-6" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const BarChartIcon = ({ size = 18, className = "" }: IP) => (
  <svg className={className} {...s(size)}>
    <rect x="2"  y="14" width="4" height="8"  rx="1" fill="currentColor" />
    <rect x="9"  y="8"  width="4" height="14" rx="1" fill="currentColor" />
    <rect x="16" y="2"  width="4" height="20" rx="1" fill="currentColor" opacity="0.7" />
  </svg>
);

export const CalendarIcon = ({ size = 18, className = "" }: IP) => (
  <svg className={className} {...s(size)} stroke="currentColor" strokeWidth="1.8">
    <rect x="3" y="4" width="18" height="18" rx="2" />
    <path d="M16 2v4M8 2v4M3 10h18" />
    <rect x="7" y="14" width="3" height="3" rx="0.5" fill="currentColor" />
    <rect x="11" y="14" width="3" height="3" rx="0.5" fill="currentColor" opacity="0.6" />
  </svg>
);

export const FlaskIcon = ({ size = 18, className = "" }: IP) => (
  <svg className={className} {...s(size)} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
    <path d="M9 3h6M9 3v8l-5 9a1 1 0 0 0 .9 1.5h14.2A1 1 0 0 0 20 20l-5-9V3" />
    <path d="M7.5 18h9" opacity="0.5" />
  </svg>
);

export const RocketIcon = ({ size = 18, className = "", color = "currentColor" }: IP) => (
  <svg className={className} {...s(size)}>
    <path d="M12 2C9 5 7 9 7 13v3l-3 2v1h16v-1l-3-2v-3c0-4-2-8-5-11Z" fill={color} opacity="0.9" />
    <path d="M9 19c0 2 1.5 3 3 3s3-1 3-3" fill={color} opacity="0.6" />
    <ellipse cx="12" cy="9" rx="2" ry="2.5" fill="white" opacity="0.4" />
  </svg>
);

export const LayersIcon = ({ size = 18, className = "" }: IP) => (
  <svg className={className} {...s(size)} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <polygon points="12 2 22 8.5 12 15 2 8.5" />
    <polyline points="2 15.5 12 22 22 15.5" />
    <polyline points="2 12 12 18.5 22 12" opacity="0.5" />
  </svg>
);

export const LockIcon = ({ size = 18, className = "" }: IP) => (
  <svg className={className} {...s(size)}>
    <rect x="3" y="11" width="18" height="11" rx="2" fill="currentColor" opacity="0.85" />
    <path d="M7 11V7a5 5 0 0 1 10 0v4" stroke="currentColor" strokeWidth="2" fill="none" />
    <circle cx="12" cy="16" r="1.5" fill="white" />
  </svg>
);

export const NewspaperIcon = ({ size = 18, className = "" }: IP) => (
  <svg className={className} {...s(size)} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <path d="M7 8h10M7 12h10M7 16h6" />
    <rect x="3" y="3" width="5" height="5" rx="1" fill="currentColor" opacity="0.3" />
  </svg>
);

export const AwardIcon = ({ size = 18, className = "", color = "currentColor" }: IP) => (
  <svg className={className} {...s(size)}>
    <circle cx="12" cy="9" r="7" fill={color} opacity="0.9" />
    <path d="M8.5 16.5L7 22l5-2 5 2-1.5-5.5" fill={color} opacity="0.6" />
    <path d="M9.5 9.5l1.5 1 2.5-3" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const TerminalCmdIcon = ({ size = 18, className = "" }: IP) => (
  <svg className={className} {...s(size)} stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <rect x="2" y="3" width="20" height="18" rx="2" />
    <path d="M7 9l3 3-3 3M13 15h4" />
  </svg>
);

export const FlameIcon = ({ size = 18, className = "", color = "currentColor" }: IP) => (
  <svg className={className} {...s(size)}>
    <path d="M12 2c0 0-1 4-4 6 0 0 1-4-2-6C6 2 2 7 2 12a10 10 0 0 0 20 0c0-5-4-8-4-8s1 4-3 5c0 0 1-5-3-7Z" fill={color} opacity="0.9" />
    <path d="M12 22c-2.5 0-4-2-4-4 0-2 2-3 4-4 2 1 4 2 4 4 0 2-1.5 4-4 4Z" fill="white" opacity="0.35" />
  </svg>
);

export const SkullIcon = ({ size = 18, className = "" }: IP) => (
  <svg className={className} {...s(size)}>
    <path d="M12 3a8 8 0 0 0-8 8c0 3 1.5 5.5 4 7v2h8v-2c2.5-1.5 4-4 4-7a8 8 0 0 0-8-8Z" fill="currentColor" opacity="0.85" />
    <circle cx="9" cy="11" r="1.5" fill="white" />
    <circle cx="15" cy="11" r="1.5" fill="white" />
    <path d="M10 19h4M10 21h4" stroke="white" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
);

export const ChevronRightIcon = ({ size = 18, className = "" }: IP) => (
  <svg className={className} {...s(size)} stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M9 6l6 6-6 6" />
  </svg>
);

export const BotIcon = ({ size = 18, className = "" }: IP) => (
  <svg className={className} {...s(size)}>
    <rect x="3" y="8" width="18" height="12" rx="3" fill="currentColor" opacity="0.85" />
    <circle cx="9" cy="14" r="2" fill="white" />
    <circle cx="15" cy="14" r="2" fill="white" />
    <rect x="10" y="3" width="4" height="5" rx="2" fill="currentColor" />
    <circle cx="12" cy="3" r="1.5" fill="currentColor" />
    <path d="M7 8V6M17 8V6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
  </svg>
);

export const SparklesIcon = ({ size = 18, className = "", color = "currentColor" }: IP) => (
  <svg className={className} {...s(size)}>
    <path d="M12 2l1.5 4.5L18 8l-4.5 1.5L12 14l-1.5-4.5L6 8l4.5-1.5L12 2Z" fill={color} />
    <path d="M19 14l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2Z" fill={color} opacity="0.6" />
    <path d="M5 17l.5 1.5L7 19l-1.5.5L5 21l-.5-1.5L3 19l1.5-.5L5 17Z" fill={color} opacity="0.5" />
  </svg>
);

export const MinusIcon = ({ size = 18, className = "" }: IP) => (
  <svg className={className} {...s(size)}>
    <rect x="3" y="11" width="18" height="2.5" rx="1.25" fill="currentColor" />
  </svg>
);
