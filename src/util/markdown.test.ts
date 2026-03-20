import { describe, test, expect } from "bun:test";
import { markdownToTelegramHTML, stripMarkdown, formatToolInput } from "./markdown";

describe("markdownToTelegramHTML", () => {
  test("converts bold (**) to <b>", () => {
    expect(markdownToTelegramHTML("**hello**")).toBe("<b>hello</b>");
  });

  test("converts bold (__) to <b>", () => {
    expect(markdownToTelegramHTML("__hello__")).toBe("<b>hello</b>");
  });

  test("converts italic (*) to <i>", () => {
    expect(markdownToTelegramHTML("*hello*")).toBe("<i>hello</i>");
  });

  test("converts italic (_) to <i>", () => {
    expect(markdownToTelegramHTML("some _italic_ text")).toBe("some <i>italic</i> text");
  });

  test("converts strikethrough (~~) to <s>", () => {
    expect(markdownToTelegramHTML("~~deleted~~")).toBe("<s>deleted</s>");
  });

  test("converts inline code to <code>", () => {
    const result = markdownToTelegramHTML("use `console.log`");
    expect(result).toBe("use <code>console.log</code>");
  });

  test("converts fenced code blocks to <pre><code>", () => {
    const input = "```js\nconsole.log('hi')\n```";
    const result = markdownToTelegramHTML(input);
    expect(result).toContain('<pre><code class="language-js">');
    // escapeHtml only escapes &, <, > — single quotes are preserved
    expect(result).toContain("console.log('hi')");
    expect(result).toContain("</code></pre>");
  });

  test("converts fenced code blocks without language", () => {
    const input = "```\nsome code\n```";
    const result = markdownToTelegramHTML(input);
    expect(result).toContain("<pre><code>");
    expect(result).toContain("some code");
    expect(result).toContain("</code></pre>");
  });

  test("converts headers to bold", () => {
    expect(markdownToTelegramHTML("# Title")).toBe("<b>Title</b>");
    expect(markdownToTelegramHTML("## Subtitle")).toBe("<b>Subtitle</b>");
    expect(markdownToTelegramHTML("### H3")).toBe("<b>H3</b>");
  });

  test("converts links to <a> tags", () => {
    const result = markdownToTelegramHTML("[click](https://example.com)");
    expect(result).toBe('<a href="https://example.com">click</a>');
  });

  test("converts unordered list items to bullet points", () => {
    expect(markdownToTelegramHTML("- item one")).toBe("• item one");
    expect(markdownToTelegramHTML("* item two")).toBe("• item two");
    expect(markdownToTelegramHTML("+ item three")).toBe("• item three");
  });

  test("converts blockquotes to <blockquote>", () => {
    const result = markdownToTelegramHTML("> some quote");
    expect(result).toContain("<blockquote>");
    expect(result).toContain("some quote");
    expect(result).toContain("</blockquote>");
  });

  test("handles multi-line blockquotes", () => {
    const input = "> line one\n> line two";
    const result = markdownToTelegramHTML(input);
    expect(result).toContain("<blockquote>");
    expect(result).toContain("line one\nline two");
    expect(result).toContain("</blockquote>");
  });

  test("escapes HTML entities in text", () => {
    const result = markdownToTelegramHTML("a < b & c > d");
    expect(result).toBe("a &lt; b &amp; c &gt; d");
  });

  test("escapes HTML entities inside inline code", () => {
    const result = markdownToTelegramHTML("`<div>&</div>`");
    expect(result).toContain("<code>&lt;div&gt;&amp;&lt;/div&gt;</code>");
  });

  test("escapes HTML entities inside code blocks", () => {
    const input = "```\n<p>&test</p>\n```";
    const result = markdownToTelegramHTML(input);
    expect(result).toContain("&lt;p&gt;&amp;test&lt;/p&gt;");
  });

  test("handles empty string", () => {
    expect(markdownToTelegramHTML("")).toBe("");
  });

  test("handles plain text without markdown", () => {
    expect(markdownToTelegramHTML("plain text here")).toBe("plain text here");
  });

  test("removes horizontal rules (---)", () => {
    // Only --- reliably works; *** and ___ get caught by italic rules first
    // (known limitation of regex-based markdown conversion)
    expect(markdownToTelegramHTML("---")).toBe("");
  });

  test("handles nested bold and italic", () => {
    const result = markdownToTelegramHTML("**bold and *italic***");
    expect(result).toContain("<b>");
    expect(result).toContain("<i>");
  });

  test("collapses multiple blank lines", () => {
    const result = markdownToTelegramHTML("a\n\n\n\nb");
    expect(result).toBe("a\n\nb");
  });
});

describe("stripMarkdown", () => {
  test("strips bold markers (**)", () => {
    expect(stripMarkdown("**bold**")).toBe("bold");
  });

  test("strips bold markers (__)", () => {
    expect(stripMarkdown("__bold__")).toBe("bold");
  });

  test("strips italic markers (*)", () => {
    expect(stripMarkdown("*italic*")).toBe("italic");
  });

  test("strips italic markers (_)", () => {
    expect(stripMarkdown("_italic_")).toBe("italic");
  });

  test("strips inline code backticks", () => {
    expect(stripMarkdown("`code`")).toBe("code");
  });

  test("strips code block fences and keeps content", () => {
    const input = "```js\nconsole.log('hi')\n```";
    const result = stripMarkdown(input);
    expect(result).toContain("console.log('hi')");
    expect(result).not.toContain("```");
  });

  test("strips headers", () => {
    expect(stripMarkdown("# Title")).toBe("Title");
    expect(stripMarkdown("## Subtitle")).toBe("Subtitle");
    expect(stripMarkdown("###### H6")).toBe("H6");
  });

  test("strips links but keeps text", () => {
    expect(stripMarkdown("[click here](https://example.com)")).toBe("click here");
  });

  test("converts list markers to bullet points", () => {
    expect(stripMarkdown("- item")).toBe("• item");
    expect(stripMarkdown("* item")).toBe("• item");
    expect(stripMarkdown("+ item")).toBe("• item");
    expect(stripMarkdown("1. item")).toBe("• item");
  });

  test("strips blockquote markers", () => {
    expect(stripMarkdown("> quoted text")).toBe("quoted text");
  });

  test("strips horizontal rules", () => {
    expect(stripMarkdown("---")).toBe("");
  });

  test("collapses multiple blank lines", () => {
    const result = stripMarkdown("a\n\n\n\nb");
    expect(result).toBe("a\n\nb");
  });

  test("handles empty string", () => {
    expect(stripMarkdown("")).toBe("");
  });

  test("handles plain text without markdown", () => {
    expect(stripMarkdown("plain text")).toBe("plain text");
  });
});

describe("formatToolInput", () => {
  test("formats Bash command", () => {
    const result = formatToolInput("Bash", { command: "ls -la" });
    expect(result).toBe("Command:\nls -la");
  });

  test("formats Edit with file path", () => {
    const result = formatToolInput("Edit", {
      file_path: "/some/file.ts",
      old_string: "old",
      new_string: "new",
    });
    expect(result).toContain("File: /some/file.ts");
    expect(result).toContain("Old: old");
    expect(result).toContain("New: new");
  });

  test("formats Write with file path", () => {
    const result = formatToolInput("Write", {
      file_path: "/some/file.ts",
      content: "file content",
    });
    expect(result).toContain("File: /some/file.ts");
    expect(result).toContain("Content: file content");
  });

  test("formats Read with file path", () => {
    const result = formatToolInput("Read", { file_path: "/some/file.ts" });
    expect(result).toBe("File: /some/file.ts");
  });

  test("formats Glob with pattern", () => {
    const result = formatToolInput("Glob", { pattern: "**/*.ts" });
    expect(result).toBe("Pattern: **/*.ts");
  });

  test("formats Glob with pattern and path", () => {
    const result = formatToolInput("Glob", { pattern: "*.ts", path: "/src" });
    expect(result).toBe("Pattern: *.ts\nPath: /src");
  });

  test("formats Grep with pattern", () => {
    const result = formatToolInput("Grep", { pattern: "TODO" });
    expect(result).toBe("Pattern: TODO");
  });

  test("falls back to JSON for unknown tools", () => {
    const result = formatToolInput("SomeUnknownTool", { foo: "bar" });
    expect(result).toBe('{\n  "foo": "bar"\n}');
  });

  test("truncates long JSON output", () => {
    const longValue = "x".repeat(600);
    const result = formatToolInput("SomeUnknownTool", { key: longValue });
    expect(result.length).toBeLessThanOrEqual(503); // 500 + "..."
    expect(result).toContain("...");
  });
});
