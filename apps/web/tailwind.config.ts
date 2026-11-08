import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        ex: {
          bg: "#0E131A",
          surface: "#181F2A",
          panel: "#1E2633",
          border: "#232B38",
          blue: "#2962FF", // Terminal Bullish Blue
          red: "#F23645",  // Terminal Bearish Red
          yellow: "#FFD000", // Terminal Gold Accent
          text: "#E0E3EB",
          muted: "#788292",
        },
        tv: {
          dark: "#0E131A",
          surface: "#181F2A",
          panel: "#1E2633",
          border: "#232B38",
          gold: "#FFD000",
          bullish: "#2962FF",
          bearish: "#F23645",
          text: "#E0E3EB",
          muted: "#788292",
        },
      },
      fontFamily: {
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "Monaco", "Consolas", "monospace"],
      },
    },
  },
  plugins: [],
};

export default config;
