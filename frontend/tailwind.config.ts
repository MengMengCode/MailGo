/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  darkMode: ["class", '[data-theme="dark"]'],
  theme: {
    // Responsive breakpoints for sm:/md:/lg:/xl:/2xl: utility prefixes.
    screens: {
      sm: "640px",
      md: "768px",
      lg: "1024px",
      xl: "1280px",
      "2xl": "1536px",
    },
    container: {
      center: true,
      padding: {
        DEFAULT: "1rem",
        sm: "1.5rem",
        lg: "2rem",
      },
      screens: {
        sm: "401px",
        md: "601px",
        lg: "961px",
        xl: "1200px",
        "2xl": "1400px",
      },
    },
    extend: {
      fontFamily: {
        sans: [
          "Geist Sans",
          "system-ui",
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "Roboto",
          "sans-serif",
        ],
        mono: [
          "Geist Mono",
          "SF Mono",
          "Fira Code",
          "Fira Mono",
          "Menlo",
          "Consolas",
          "monospace",
        ],
      },
      colors: {
        // Geist design tokens — light theme
        geist: {
          primary: "var(--geist-primary)",
          secondary: "var(--geist-secondary)",
          tertiary: "var(--geist-tertiary)",
          neutral: "var(--geist-neutral)",
          "bg-100": "var(--geist-bg-100)",
          "bg-200": "var(--geist-bg-200)",
          border: "var(--geist-border)",
        },
      },
      borderRadius: {
        geist: "var(--geist-radius)",
        "geist-sm": "var(--geist-radius-sm)",
        "geist-md": "12px",
        "geist-lg": "16px",
      },
      boxShadow: {
        card: "0 2px 2px rgba(0, 0, 0, 0.04)",
        popover:
          "0 1px 1px rgba(0, 0, 0, 0.02), 0 4px 8px -4px rgba(0, 0, 0, 0.04), 0 16px 24px -8px rgba(0, 0, 0, 0.06)",
        modal:
          "0 1px 1px rgba(0, 0, 0, 0.02), 0 8px 16px -4px rgba(0, 0, 0, 0.04), 0 24px 32px -8px rgba(0, 0, 0, 0.06)",
        focus: "0 0 0 2px var(--geist-bg-100), 0 0 0 4px var(--geist-focus)",
      },
      keyframes: {
        "fade-in": {
          from: { opacity: "0", transform: "translateY(4px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        "fade-in-fast": {
          from: { opacity: "0" },
          to: { opacity: "1" },
        },
        "slide-up": {
          from: { opacity: "0", transform: "translateY(12px) scale(0.95)" },
          to: { opacity: "1", transform: "translateY(0) scale(1)" },
        },
        shimmer: {
          "0%": { backgroundPosition: "-400px 0" },
          "100%": { backgroundPosition: "400px 0" },
        },
        spin: {
          from: { transform: "rotate(0deg)" },
          to: { transform: "rotate(360deg)" },
        },
      },
      animation: {
        "fade-in": "fade-in 200ms ease-out both",
        "fade-in-fast": "fade-in-fast 150ms ease-out both",
        "slide-up": "slide-up 200ms cubic-bezier(0.175, 0.885, 0.32, 1.1) both",
        shimmer: "shimmer 1.5s infinite linear",
        spin: "spin 0.8s linear infinite",
      },
      transitionTimingFunction: {
        spring: "cubic-bezier(0.175, 0.885, 0.32, 1.1)",
      },
    },
  },
  plugins: [],
};
