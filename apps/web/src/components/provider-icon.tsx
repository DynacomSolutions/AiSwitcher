import {
  siAlibabacloud,
  siAnthropic,
  siDeepseek,
  siGooglegemini,
  siMistralai,
  siMoonshotai,
  siOllama,
  siOpenrouter,
  siPerplexity,
  siQwen,
  siZdotai,
  type SimpleIcon,
} from "simple-icons";

/** Vendored from simple-icons@11.14.0 (CC-0). Upstream removed OpenAI in
 * later releases; the knot path is stable and small, so it lives here. */
const OPENAI_PATH =
  "M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9108 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9893 5.9893 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.747-7.073zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z";

/** xAI has never shipped its mark to a libre icon set; the monogram chip
 * below carries the brand instead. */
interface IconEntry {
  icon?: SimpleIcon;
  path?: string;
  color: string;
  monogram?: string;
}

const PROVIDER_ICONS: Record<string, IconEntry> = {
  anthropic: { icon: siAnthropic, color: "#d97757" },
  openai: { path: OPENAI_PATH, color: "#74aa9c" },
  xai: { monogram: "X", color: "#e4e4e7" },
  kimi: { icon: siMoonshotai, color: "#7dd3fc" },
  moonshot: { icon: siMoonshotai, color: "#7dd3fc" },
  zai: { icon: siZdotai, color: "#a78bfa" },
  alibaba: { icon: siAlibabacloud, color: "#ff6a00" },
  google: { icon: siGooglegemini, color: "#8e75b2" },
  gemini: { icon: siGooglegemini, color: "#8e75b2" },
  deepseek: { icon: siDeepseek, color: "#7c9bfe" },
  qwen: { icon: siQwen, color: "#a78bfa" },
  mistral: { icon: siMistralai, color: "#ff7000" },
  perplexity: { icon: siPerplexity, color: "#1fb8cd" },
  openrouter: { icon: siOpenrouter, color: "#93c5fd" },
  ollama: { icon: siOllama, color: "#e4e4e7" },
};

const MONOGRAM_COLOR = "#a1a1aa";

function entryFor(provider: string): { key: string; entry: IconEntry | undefined } {
  const key = provider.trim().toLowerCase();
  const entry = PROVIDER_ICONS[key];
  if (entry) return { key, entry };
  // Model-flavoured provider strings ("anthropic/claude-...", "openai/gpt-...")
  // still resolve by prefix so unrelocated aliases keep their mark.
  const prefix = Object.keys(PROVIDER_ICONS).find((known) => key.startsWith(`${known}/`) || key.startsWith(`${known}-`));
  return { key, entry: prefix ? PROVIDER_ICONS[prefix] : undefined };
}

export function ProviderIcon({ provider, size = 14, className }: { provider: string; size?: number; className?: string }) {
  const { key, entry } = entryFor(provider);
  const path = entry?.icon?.path ?? entry?.path;
  const color = entry?.color ?? MONOGRAM_COLOR;

  if (!path) {
    const letter = (entry?.monogram ?? key.charAt(0) ?? "?").toUpperCase();
    return (
      <span
        className={`inline-flex shrink-0 items-center justify-center rounded-full border border-border/60 font-semibold text-muted-foreground ${className ?? ""}`}
        style={{ width: size + 4, height: size + 4, fontSize: size - 3 }}
        title={provider}
      >
        {letter}
      </span>
    );
  }

  return (
    <svg
      role="img"
      aria-label={entry?.icon?.title ?? key}
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={`shrink-0 ${className ?? ""}`}
      style={{ color }}
      fill="currentColor"
    >
      <title>{entry?.icon?.title ?? key}</title>
      <path d={path} />
    </svg>
  );
}

/** Provider name plus its real mark, for table cells and chips. */
export function ProviderLabel({ provider, size = 14, className }: { provider: string; size?: number; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-1.5 ${className ?? ""}`}>
      <ProviderIcon provider={provider} size={size} />
      <span>{provider}</span>
    </span>
  );
}
