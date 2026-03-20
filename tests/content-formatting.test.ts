import { describe, it, expect } from "vitest";

import { formatPageContentForTelegram, maybeFormatForTelegram } from "../src/common/content-formatting";
import { renderPageContent } from "../src/common/page-content-render";

describe("formatPageContentForTelegram", () => {
  it("converts [b]...[/b] to <b>...</b>", () => {
    expect(formatPageContentForTelegram("Hello [b]world[/b]!")).toBe("Hello <b>world</b>!");
  });

  it("converts **...** to <b>...</b>", () => {
    expect(formatPageContentForTelegram("Hello **world**!")).toBe("Hello <b>world</b>!");
  });

  it("converts > lines to blockquote", () => {
    const input = "Before\n\n> Quote line 1\n> Quote line 2\n\nAfter";
    const expected = "Before\n\n<blockquote>Quote line 1\nQuote line 2</blockquote>\n\nAfter";
    expect(formatPageContentForTelegram(input)).toBe(expected);
  });

  it("escapes user content for HTML safety", () => {
    expect(formatPageContentForTelegram("x < 5 & y > 3")).toBe("x &lt; 5 &amp; y &gt; 3");
  });

  it("preserves line breaks and paragraphs", () => {
    const input = "Para 1\n\nPara 2";
    expect(formatPageContentForTelegram(input)).toBe("Para 1\n\nPara 2");
  });

  it("handles mixed bold and blockquote", () => {
    const input = "[b]Title[/b]\n\n> Quote with **bold**";
    expect(formatPageContentForTelegram(input)).toContain("<b>Title</b>");
    expect(formatPageContentForTelegram(input)).toContain("<blockquote>");
    expect(formatPageContentForTelegram(input)).toContain("<b>bold</b>");
  });

  it("returns empty string for empty input", () => {
    expect(formatPageContentForTelegram("")).toBe("");
    expect(formatPageContentForTelegram("   ")).toBe("   ");
  });

  it("handles plain text without formatting", () => {
    expect(formatPageContentForTelegram("Just plain text")).toBe("Just plain text");
  });

  it("escapes content inside bold tags", () => {
    expect(formatPageContentForTelegram("[b]x < y[/b]")).toBe("<b>x &lt; y</b>");
  });
});

describe("maybeFormatForTelegram", () => {
  it("passes through existing HTML unchanged", () => {
    const html = "Hello <b>world</b>!";
    expect(maybeFormatForTelegram(html)).toBe(html);
  });

  it("passes through blockquote HTML", () => {
    const html = "<blockquote>Quote text</blockquote>";
    expect(maybeFormatForTelegram(html)).toBe(html);
  });

  it("converts authoring format [b] to HTML", () => {
    expect(maybeFormatForTelegram("[b]bold[/b]")).toContain("<b>bold</b>");
  });

  it("converts plain text (escapes it)", () => {
    expect(maybeFormatForTelegram("plain")).toBe("plain");
  });
});

describe("renderPageContent", () => {
  const profile = {
    firstName: "John",
    lastName: "Doe",
    username: "johndoe",
    fullName: "John Doe"
  };

  it("substitutes placeholders and formats", () => {
    const result = renderPageContent("Hello {name}, see [b]bold[/b]", profile);
    expect(result).toContain("John");
    expect(result).toContain("<b>bold</b>");
  });

  it("escapes substituted values for HTML", () => {
    const result = renderPageContent("Hi {name}", { firstName: "John<script>" });
    expect(result).not.toContain("<script>");
    expect(result).toContain("&lt;");
  });

  it("returns empty for empty input", () => {
    expect(renderPageContent("", profile)).toBe("");
  });

  it("handles blockquote with placeholders", () => {
    const result = renderPageContent("> Quote for {name}", profile);
    expect(result).toContain("<blockquote>");
    expect(result).toContain("John");
  });

  it("passes through stored HTML from entities and substitutes placeholders", () => {
    const stored = "Hello <b>{name}</b>!";
    const result = renderPageContent(stored, profile);
    expect(result).toContain("<b>");
    expect(result).toContain("John");
    expect(result).not.toContain("{name}");
  });
});
