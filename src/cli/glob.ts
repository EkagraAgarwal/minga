/**
 * The Bun.Glob subset the kit needs while running under plain Node: `*`, `**`,
 * `?`, `{a,b}`, `[abc]`/`[!abc]` and backslash escapes. No Bun APIs, no deps.
 *
 * `*` and `?` stay inside one path segment; a `**` that is a whole segment
 * matches zero or more segments (a trailing `**` needs at least one, so
 * `test/**` matches `test/a.ts` and `test/` but not `test`). This mirrors the
 * Bun.Glob behaviour the server uses for `protect` and `paths`.
 */
const MAX_EXPANSIONS = 256;

function escapeRegex(char: string): string {
  return /[\\^$.*+?()[\]{}|]/.test(char) ? `\\${char}` : char;
}

/** Expand `{a,b}` (nested allowed) into a bounded list of plain patterns. */
export function expandBraces(pattern: string): string[] {
  const out: string[] = [];
  let prefix = "";
  let i = 0;
  while (i < pattern.length) {
    const char = pattern[i]!;
    if (char === "\\" && i + 1 < pattern.length) {
      prefix += char + pattern[i + 1]!;
      i += 2;
      continue;
    }
    if (char !== "{") {
      prefix += char;
      i++;
      continue;
    }
    let depth = 1;
    let j = i + 1;
    let start = j;
    const parts: string[] = [];
    while (j < pattern.length && depth > 0) {
      const current = pattern[j]!;
      if (current === "\\" && j + 1 < pattern.length) {
        j += 2;
        continue;
      }
      if (current === "{") depth++;
      if (current === "}") {
        depth--;
        if (depth === 0) {
          parts.push(pattern.slice(start, j));
          break;
        }
      }
      if (current === "," && depth === 1) {
        parts.push(pattern.slice(start, j));
        start = j + 1;
      }
      j++;
    }
    if (depth !== 0) {
      out.push(`${prefix}${pattern.slice(i)}`);
      return out;
    }
    const alternatives = parts.flatMap(expandBraces).slice(0, MAX_EXPANSIONS);
    const suffixes = expandBraces(pattern.slice(j + 1)).slice(0, MAX_EXPANSIONS);
    for (const alternative of alternatives) {
      for (const suffix of suffixes) out.push(`${prefix}${alternative}${suffix}`);
      if (out.length >= MAX_EXPANSIONS) return out.slice(0, MAX_EXPANSIONS);
    }
    return out.slice(0, MAX_EXPANSIONS);
  }
  out.push(prefix);
  return out;
}

/** Translate one path segment (no globstar) to an anchored regexp. */
function segmentPattern(segment: string): RegExp {
  let source = "";
  for (let i = 0; i < segment.length; i++) {
    const char = segment[i]!;
    if (char === "\\" && i + 1 < segment.length) {
      source += escapeRegex(segment[++i]!);
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else if (char === "[") {
      // Read a character class; a leading '!' negates it and a leading ']' is literal.
      let j = i + 1;
      if (segment[j] === "!" || segment[j] === "^") j++;
      if (segment[j] === "]") j++;
      while (j < segment.length && segment[j] !== "]") {
        j += segment[j] === "\\" && j + 1 < segment.length ? 2 : 1;
      }
      if (j >= segment.length) {
        source += "\\[";
      } else {
        let body = segment.slice(i + 1, j);
        if (body.startsWith("!")) body = `^${body.slice(1)}`;
        body = body.replace(/\\[!\]^\\-]/g, "\\$1").replace(/^\]/, "\\]");
        try {
          source += `[${body}]`;
        } catch {
          source += "\\[";
        }
        i = j;
      }
    } else {
      source += escapeRegex(char);
    }
  }
  return new RegExp(`^${source}$`);
}

function matchSegments(
  pattern: string[], path: string[], pi: number, si: number, afterGlobstar = false,
): boolean {
  if (pi === pattern.length) return si === path.length;
  const segment = pattern[pi]!;
  if (segment === "**") {
    const last = pi === pattern.length - 1;
    for (let next = si; next <= path.length; next++) {
      if (last) {
        if (next > si && next === path.length) return true;
      } else if (matchSegments(pattern, path, pi + 1, next, true)) {
        return true;
      }
    }
    return false;
  }
  // A segment after `**/` must be a real segment: Bun.Glob("**/*") does not
  // match a trailing slash, while "**/" itself does.
  if (si >= path.length || (afterGlobstar && segment !== "" && path[si] === "")) return false;
  if (!segmentPattern(segment).test(path[si]!)) return false;
  return matchSegments(pattern, path, pi + 1, si + 1, false);
}

/** True when `path` matches `pattern` (Bun.Glob's default, dotfiles included). */
export function globMatch(pattern: string, path: string): boolean {
  if (path === "" && pattern.split("/").length > 1) return false;
  return expandBraces(pattern).some((expanded) => matchSegments(expanded.split("/"), path.split("/"), 0, 0));
}

/** `project.toml` is always protected on the server, even when not listed. */
export function isProtectedPath(path: string, protect: readonly string[]): boolean {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "");
  return normalized === "project.toml" || protect.some((pattern) => globMatch(pattern, normalized));
}
