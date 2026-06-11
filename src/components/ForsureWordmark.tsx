/**
 * Forsure wordmark using currentColor so it adapts to the site theme.
 * Inspired by the Playfair-style brand mark with a blue accent dot on the "o".
 */
export default function ForsureWordmark({ className = "h-7" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 360 90"
      xmlns="http://www.w3.org/2000/svg"
      className={`${className} w-auto select-none`}
      role="img"
      aria-label="Forsure"
    >
      <text
        x="0"
        y="68"
        fontFamily="'Playfair Display', Georgia, serif"
        fontWeight={600}
        fontSize="78"
        letterSpacing="-2"
        fill="currentColor"
      >
        forsure
      </text>
      {/* Brand blue dot inside the "o" */}
      <circle cx="63" cy="48" r="6" fill="hsl(var(--primary))" />
    </svg>
  );
}
