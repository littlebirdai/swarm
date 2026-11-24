import { describe, expect, test } from "bun:test";
import { PAGE_THEME_MESSAGE } from "@codecast/render/pageTheme";
import {
  renderMarkdownDocument,
  restyleMarkdownDocument,
} from "./artifactMarkdown";

describe("artifactMarkdown", () => {
  test("headings get stable GitHub-style ids with a self link", async () => {
    const html = await renderMarkdownDocument(
      "# Hello, World!\n\n## Hello, World!\n\n### Ünïcode & <tags>\n\n# !!!\n\n# !!!",
      "Headings",
    );
    expect(html).toContain('<h1 id="hello-world">');
    expect(html).toContain('<h1 id="section">');
    expect(html).toContain('<h1 id="section-1">');
    expect(html).toContain('<h2 id="hello-world-1">');
    expect(html).toContain('<h3 id="ünïcode">');
    expect(html).toContain('<a class="anchor" href="#hello-world"');
  });

  test("fenced code is highlighted server-side and labelled with its language", async () => {
    const html = await renderMarkdownDocument(
      "```ts\nconst x: number = 1;\n```",
      "Code",
    );
    expect(html).toContain('<pre data-lang="ts"><code class="language-ts">');
    expect(html).toContain('class="hljs-keyword">const</span>');
  });

  test("unknown languages fall back to escaped text, and html in code never leaks", async () => {
    const html = await renderMarkdownDocument(
      "```nope-lang\n<script>alert(1)</script>\n```",
      "Unknown code",
    );
    expect(html).toContain('<pre data-lang="nope-lang">');
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert");
  });

  test("tables are wrapped for horizontal scroll and keep alignment", async () => {
    const html = await renderMarkdownDocument(
      "| a | b |\n|:--|--:|\n| 1 | 2 |",
      "Table",
    );
    expect(html).toContain('<div class="tbl"><table><thead>');
    expect(html).toContain('<th style="text-align:left">a</th>');
    expect(html).toContain('<td style="text-align:right">2</td>');
  });

  test("a column holding sentences is marked so it keeps a readable width", async () => {
    const html = await renderMarkdownDocument(
      "| arm | what it is | p |\n|--|--|--|\n| c | reference: agent review with tools and more | 0.88 |\n| b | short | 0.82 |",
      "Wide table",
    );
    expect(html).toContain('<th class="prose">what it is</th>');
    expect(html).toContain('<td class="prose">short</td>');
    expect(html).toContain("<td>0.88</td>");
    expect(html).toContain("<th>arm</th>");
  });

  test("the document shell includes the title, content, color scheme, and copy buttons", async () => {
    const html = await renderMarkdownDocument("# T", "A <title>");
    expect(html).toContain("<title>A &lt;title&gt;</title>");
    expect(html).toContain('<main class="md">');
    expect(html).toContain('<meta name="color-scheme" content="light dark">');
    expect(html).toContain('querySelectorAll(".md pre")');
  });

  test("the theme is chosen in <head>, before the first paint, and the page carries its toggle", async () => {
    const html = await renderMarkdownDocument("# T", "t");
    const initializer = html.indexOf('setAttribute("data-theme"');
    expect(initializer).toBeGreaterThan(html.indexOf("<head>"));
    expect(initializer).toBeLessThan(html.indexOf("</head>"));
    expect(html).toContain('class="md-theme"');
    expect(html).toContain(JSON.stringify(PAGE_THEME_MESSAGE));
    expect(html).toMatch(
      /:root\[data-theme=dark\]\s*\{\s*color-scheme:\s*dark;\s*--md-page:/,
    );
  });

  test("a stored page is served in the current shell, with its body untouched", () => {
    const body = '<h1 id="x">Old</h1>\n<p>kept</p>\n';
    const old = `<!doctype html><html><head><style>:root{--md-bg:#fbfaf8}</style></head><body>\n<main class="md">\n${body}\n</main>\n<script>old</script></body></html>`;
    const restyled = restyleMarkdownDocument(old, "New title");
    expect(restyled).toContain(`<main class="md">\n${body}\n</main>`);
    expect(restyled).toContain("<title>New title</title>");
    expect(restyled).not.toContain("#fbfaf8");
    expect(restyled).not.toContain("<script>old</script>");
  });

  test("a document that is not in the stored shape is served as it is", () => {
    const other = "<html><body><main>raw</main></body></html>";
    expect(restyleMarkdownDocument(other, "t")).toBe(other);
  });
});
