export default function BrandLogo({ className = "h-12" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 400 80"
      className={className}
      xmlns="http://www.w3.org/2000/svg"
      aria-label="Forsure"
    >
      <defs>
        <linearGradient id="brand-gradient" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="hsl(220, 80%, 60%)" />
          <stop offset="40%" stopColor="hsl(220, 90%, 75%)" />
          <stop offset="60%" stopColor="hsl(0, 0%, 95%)" />
          <stop offset="100%" stopColor="hsl(350, 70%, 55%)" />
        </linearGradient>
        <linearGradient id="brand-shine" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor="white" stopOpacity="0.4" />
          <stop offset="50%" stopColor="white" stopOpacity="0" />
          <stop offset="100%" stopColor="white" stopOpacity="0.15" />
        </linearGradient>
      </defs>
      <text
        x="200"
        y="60"
        textAnchor="middle"
        fontFamily="'Inter', 'Helvetica Neue', Arial, sans-serif"
        fontWeight="800"
        fontSize="68"
        letterSpacing="6"
        fill="url(#brand-gradient)"
      >
        FORSURE
      </text>
      <text
        x="200"
        y="60"
        textAnchor="middle"
        fontFamily="'Inter', 'Helvetica Neue', Arial, sans-serif"
        fontWeight="800"
        fontSize="68"
        letterSpacing="6"
        fill="url(#brand-shine)"
      >
        FORSURE
      </text>
    </svg>
  );
}
