// A bounded list of real top-level domains used to decide whether a
// dot-separated, label-shaped token is plausibly a hostname at all.
//
// This is deliberately NOT the full ~1500-entry IANA registry: it is ISO
// 3166-1 alpha-2 country codes (the actual ccTLD namespace) plus the gTLDs
// this project, or software like it, plausibly references. A shorter list
// means fewer accidental collisions with ordinary English words or code
// identifiers that happen to end in two-to-three letters (see
// scripts/identifier-allowlist.ts's EXCLUDED_TLDS for tokens explicitly
// carved back out, such as file extensions that are ALSO real ccTLDs).
//
// This list intentionally does not need to be exhaustive: something wrongly
// left out here fails safe (the scanner simply won't consider it a domain
// candidate, same as any other plain word) — a real leak of an org's own
// infrastructure is caught by the other checks in this project (private IP
// ranges, home paths, the reviewed allowlist). Extending it is safe at any
// time.

const CC_TLDS = [
  "ac", "ad", "ae", "af", "ag", "ai", "al", "am", "ao", "aq", "ar", "as", "at",
  "au", "aw", "ax", "az", "ba", "bb", "bd", "be", "bf", "bg", "bh", "bi", "bj",
  "bm", "bn", "bo", "bq", "br", "bs", "bt", "bv", "bw", "by", "bz", "ca", "cc",
  "cd", "cf", "cg", "ch", "ci", "ck", "cl", "cm", "cn", "co", "cr", "cu", "cv",
  "cw", "cx", "cy", "cz", "de", "dj", "dk", "dm", "do", "dz", "ec", "ee", "eg",
  "eh", "er", "es", "et", "eu", "fi", "fj", "fk", "fm", "fo", "fr", "ga", "gb",
  "gd", "ge", "gf", "gg", "gh", "gi", "gl", "gm", "gn", "gp", "gq", "gr", "gs",
  "gt", "gu", "gw", "gy", "hk", "hm", "hn", "hr", "ht", "hu", "id", "ie", "il",
  "im", "in", "io", "iq", "ir", "is", "it", "je", "jm", "jo", "jp", "ke", "kg",
  "kh", "ki", "km", "kn", "kp", "kr", "kw", "ky", "kz", "la", "lb", "lc", "li",
  "lk", "lr", "ls", "lt", "lu", "lv", "ly", "ma", "mc", "md", "me", "mg", "mh",
  "mk", "ml", "mm", "mn", "mo", "mp", "mq", "mr", "ms", "mt", "mu", "mv", "mw",
  "mx", "my", "mz", "na", "nc", "ne", "nf", "ng", "ni", "nl", "no", "np", "nr",
  "nu", "nz", "om", "pa", "pe", "pf", "pg", "ph", "pk", "pl", "pm", "pn", "pr",
  "ps", "pt", "pw", "py", "qa", "re", "ro", "rs", "ru", "rw", "sa", "sb", "sc",
  "sd", "se", "sg", "sh", "si", "sk", "sl", "sm", "sn", "so", "sr", "ss", "st",
  "su", "sv", "sx", "sy", "sz", "tc", "td", "tf", "tg", "th", "tj", "tk", "tl",
  "tm", "tn", "to", "tr", "tt", "tv", "tw", "tz", "ua", "ug", "uk", "us", "uy",
  "uz", "va", "vc", "ve", "vg", "vi", "vn", "vu", "wf", "ws", "ye", "yt", "za",
  "zm", "zw",
] as const;

const G_TLDS = [
  "com", "org", "net", "edu", "gov", "mil", "int", "info", "biz", "name",
  "pro", "mobi", "travel", "museum", "coop", "aero", "jobs", "cat", "asia",
  "xxx", "dev", "app", "cloud", "xyz", "online", "site", "tech", "store",
  "blog", "wiki", "guide", "systems", "solutions", "studio", "agency",
  "ventures", "world", "live", "chat", "run", "page", "click", "top", "link",
  "email", "support", "software", "digital", "network", "services", "group",
  "team", "work", "design", "media",
] as const;

export const REAL_TLDS: ReadonlySet<string> = new Set([...CC_TLDS, ...G_TLDS]);
