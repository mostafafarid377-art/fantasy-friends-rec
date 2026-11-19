export function Mark({ size = 28, className = "" }: { size?: number; className?: string }) {
  return (
    <svg
      viewBox="0 0 48 48"
      width={size}
      height={size}
      className={className}
      role="img"
      aria-label="Fantasy Friends"
    >
      <defs>
        <linearGradient id="ff-g" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#8CFFC0" />
          <stop offset="100%" stopColor="#1C8F52" />
        </linearGradient>
      </defs>
      {/* crest */}
      <path
        d="M24 2.5 43.5 9.4v17.2c0 9.2-7.6 15.9-19.5 19.9C12.1 42.5 4.5 35.8 4.5 26.6V9.4L24 2.5Z"
        fill="#0A100D"
        stroke="url(#ff-g)"
        strokeWidth="2.4"
        strokeLinejoin="round"
      />
      {/* pitch centre circle + halfway line */}
      <path
        d="M4.5 24.6h39"
        stroke="#1E2B24"
        strokeWidth="1.6"
      />
      <circle cx="24" cy="24.6" r="7.4" fill="none" stroke="#1E2B24" strokeWidth="1.6" />
      {/* F F monogram */}
      <path
        d="M15.6 33.8V15.4h11.2v2.9h-7.9v5.1h6.7v2.9h-6.7v7.5h-3.3Z"
        fill="url(#ff-g)"
      />
      <path
        d="M28.6 33.8V15.4h3.3v15.5h7.5v2.9H28.6Z"
        fill="#E8F0EC"
        opacity="0.9"
      />
    </svg>
  );
}

export function Wordmark({ className = "" }: { className?: string }) {
  return (
    <span className={`flex items-center gap-2.5 ${className}`}>
      <Mark size={26} />
      <span className="font-display text-[19px] font-extrabold uppercase leading-none tracking-[0.02em] text-chalk">
        Fantasy<span className="text-green">Friends</span>
      </span>
    </span>
  );
}
