export function stripMarkdown(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/_(.+?)_/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/```[\s\S]*?```/g, (match) => match.replace(/```\w*\n?/g, "").trim())
    .replace(/^#{1,6}\s+(.+)$/gm, "$1")
    .replace(/\[([^\]]+)\]\([^\)]+\)/g, "$1")
    .replace(/^[-*+]\s+/gm, "• ")
    .replace(/^\d+\.\s+/gm, "• ")
    .replace(/^>\s+/gm, "")
    .replace(/^---+$/gm, "")
    .replace(/\n{3,}/g, "\n\n");
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function markdownToTelegramHTML(text: string): string {
  const codeBlocks: Array<{ lang: string; content: string }> = [];
  const inlineCodes: string[] = [];

  let processed = text.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang: string, content: string) => {
    const placeholder = `CODEBLOCK_PLACEHOLDER_${codeBlocks.length}`;
    codeBlocks.push({ lang, content });
    return placeholder;
  });

  processed = processed.replace(/`([^`\n]+)`/g, (_, content: string) => {
    const placeholder = `INLINE_CODE_PLACEHOLDER_${inlineCodes.length}`;
    inlineCodes.push(content);
    return placeholder;
  });

  processed = escapeHtml(processed)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    .replace(/__(.+?)__/g, "<b>$1</b>")
    .replace(/~~(.+?)~~/g, "<s>$1</s>")
    .replace(/\*(.+?)\*/g, "<i>$1</i>")
    .replace(/(^|[^a-zA-Z0-9_])_(.+?)_(?![a-zA-Z0-9_])/g, "$1<i>$2</i>")
    .replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>")
    .replace(/^(?:---|\*\*\*|___)\s*$/gm, "")
    .replace(/^[-*+]\s+(.+)$/gm, "• $1");

  const lines = processed.split("\n");
  const withBlockquotes: string[] = [];
  let blockquoteBuffer: string[] = [];

  for (const line of lines) {
    if (/^&gt;\s+/.test(line)) {
      blockquoteBuffer.push(line.replace(/^&gt;\s+/, ""));
      continue;
    }

    if (blockquoteBuffer.length > 0) {
      withBlockquotes.push(`<blockquote>${blockquoteBuffer.join("\n")}</blockquote>`);
      blockquoteBuffer = [];
    }

    withBlockquotes.push(line);
  }

  if (blockquoteBuffer.length > 0) {
    withBlockquotes.push(`<blockquote>${blockquoteBuffer.join("\n")}</blockquote>`);
  }

  processed = withBlockquotes.join("\n")
    .replace(/INLINE_CODE_PLACEHOLDER_(\d+)/g, (_, index: string) => {
      const content = inlineCodes[Number(index)] ?? "";
      return `<code>${escapeHtml(content)}</code>`;
    })
    .replace(/CODEBLOCK_PLACEHOLDER_(\d+)/g, (_, index: string) => {
      const block = codeBlocks[Number(index)];
      if (!block) return "";
      const langAttr = block.lang ? ` class="language-${block.lang}"` : "";
      return `<pre><code${langAttr}>${escapeHtml(block.content)}</code></pre>`;
    })
    .replace(/\n{3,}/g, "\n\n");

  return processed;
}

export function formatToolInput(toolName: string, input: Record<string, unknown>): string {
  if (toolName === "Bash" && input.command) {
    return `Command:\n${input.command}`;
  }
  if (toolName === "Edit" && input.file_path) {
    return `File: ${input.file_path}\nOld: ${String(input.old_string || "").slice(0, 100)}...\nNew: ${String(input.new_string || "").slice(0, 100)}...`;
  }
  if (toolName === "Write" && input.file_path) {
    return `File: ${input.file_path}\nContent: ${String(input.content || "").slice(0, 200)}...`;
  }
  if (toolName === "Read" && input.file_path) {
    return `File: ${input.file_path}`;
  }
  if (toolName === "Glob" && input.pattern) {
    return `Pattern: ${input.pattern}${input.path ? `\nPath: ${input.path}` : ""}`;
  }
  if (toolName === "Grep" && input.pattern) {
    return `Pattern: ${input.pattern}${input.path ? `\nPath: ${input.path}` : ""}`;
  }
  const json = JSON.stringify(input, null, 2);
  return json.length > 500 ? json.slice(0, 500) + "..." : json;
}
